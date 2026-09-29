import { Queue, Worker, type Job, type Processor } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { run, uid, one } from "./db";
import { env } from "./env";

export const QUEUE = {
  publish: "sd.publish",
  reply: "sd.reply",
  stream: "sd.stream",
  metrics: "sd.metrics",
  agent: "sd.agent",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Connection factory: BullMQ needs a dedicated connection per worker (blocking commands). */
export function redisConnection(): Redis {
  return new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

let sharedClient: Redis | null = null;
const queues = new Map<string, Queue>();

export function shared() {
  if (!sharedClient) {
    sharedClient = redisConnection();
    sharedClient.on("error", () => {
      /* handled by callers through ping(); swallow to avoid an unhandled emitter crash */
    });
  }
  return sharedClient;
}

let mode: "unknown" | "redis" | "inline" = "unknown";

export async function detectMode(force = false): Promise<"redis" | "inline"> {
  if (mode !== "unknown" && !force) return mode;
  // A missing Redis must never stall the request path: race the ping against a short timer
  // so the inline wheel takes over within a second instead of hanging on reconnect.
  try {
    const pong = shared().ping();
    const winner = await Promise.race([
      pong.then(() => "redis" as const).catch(() => "inline" as const),
      new Promise<"inline">((r) => setTimeout(() => r("inline"), 1500)),
    ]);
    mode = winner;
  } catch {
    mode = "inline";
  }
  return mode;
}

export function queueModeSync() {
  return mode === "unknown" ? "inline" : mode;
}

export function getQueue(name: QueueName): Queue | null {
  if (queueModeSync() !== "redis") return null;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection(), defaultJobOptions: { removeOnComplete: 500, removeOnFail: 1000 } });
    queues.set(name, q);
  }
  return q;
}

export interface EnqueueInput<T> {
  queue: QueueName;
  name: string;
  data: T;
  delayMs?: number;
  refTable?: string;
  refId?: string;
  jobId?: string;
}

/**
 * Enqueue work and keep a SQL ledger row for it, so the dashboard can show queue state
 * even when Redis is not reachable (inline mode below).
 */
export async function enqueue<T extends object>(input: EnqueueInput<T>): Promise<string> {
  const ledgerId = uid("job");
  const mode = await detectMode();
  run(
    `INSERT INTO job_runs (id, queue, job_name, ref_table, ref_id, payload_json, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ledgerId,
    input.queue,
    input.name,
    input.refTable ?? null,
    input.refId ?? null,
    JSON.stringify(input.data),
    input.delayMs && input.delayMs > 0 ? "delayed" : "queued",
  );

  const q = getQueue(input.queue);
  if (q && mode === "redis") {
    try {
      const job = await q.add(input.name, { ...input.data, ledgerId } as any, {
        delay: input.delayMs && input.delayMs > 0 ? input.delayMs : undefined,
        jobId: input.jobId,
        attempts: 1, // retries are owned by the ledger so the UI always sees the same history
      });
      run("UPDATE job_runs SET result_json = ? WHERE id = ?", JSON.stringify({ bullJobId: job.id }), ledgerId);
      return ledgerId;
    } catch (err) {
      run(
        "UPDATE job_runs SET error = ?, state = 'failed' WHERE id = ?",
        `redis add failed: ${err instanceof Error ? err.message : String(err)}`,
        ledgerId,
      );
    }
  }

  if (inlineTimers.has(ledgerId)) clearTimeout(inlineTimers.get(ledgerId)!);
  inlineTimers.set(
    ledgerId,
    setTimeout(() => {
      inlineTimers.delete(ledgerId);
      void inlineDispatch(input.queue, input.name, { ...input.data, ledgerId });
    }, input.delayMs && input.delayMs > 0 ? input.delayMs : 50),
  );
  return ledgerId;
}

/* --------------------------------------------------------------------------
 * Inline fallback: the worker process keeps its own timer wheel when Redis is
 * unreachable. Single-node only; every job still lands in the ledger first.
 * ------------------------------------------------------------------------ */

const inlineTimers = new Map<string, NodeJS.Timeout>();
const inlineHandlers = new Map<string, Processor<any>>();

export function registerInline(name: QueueName, processor: Processor<any>) {
  inlineHandlers.set(name, processor);
}

async function inlineDispatch(queue: QueueName, jobName: string, data: any) {
  const processor = inlineHandlers.get(queue);
  if (!processor) return;
  const fake = { id: data.ledgerId, name: jobName, data } as unknown as Job;
  await safeRun(queue, fake, processor);
}

/* -------------------------------------------------------------------------- */

function ledgerStart(ledgerId?: string) {
  if (!ledgerId) return;
  run(
    "UPDATE job_runs SET state = 'active', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?",
    ledgerId,
  );
}

function ledgerDone(ledgerId: string | undefined, result: unknown) {
  if (!ledgerId) return;
  run(
    "UPDATE job_runs SET state = 'completed', finished_at = datetime('now'), result_json = ? WHERE id = ?",
    JSON.stringify(result ?? null).slice(0, 4000),
    ledgerId,
  );
}

export function ledgerFail(ledgerId: string | undefined, err: unknown) {
  if (!ledgerId) return;
  run(
    "UPDATE job_runs SET state = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?",
    (err instanceof Error ? err.message : String(err)).slice(0, 2000),
    ledgerId,
  );
}

async function safeRun(queue: string, job: Job, processor: Processor<any>) {
  const ledgerId = (job.data as any)?.ledgerId as string | undefined;
  ledgerStart(ledgerId);
  try {
    const result = await processor(job);
    ledgerDone(ledgerId, result);
    return result;
  } catch (err) {
    ledgerFail(ledgerId, err);
    throw err;
  }
}

/** Real BullMQ worker when Redis is up; also registers the inline handler for the fallback path. */
export function startWorker(
  name: QueueName,
  processor: Processor<any>,
  opts: { concurrency?: number } = {},
): Worker | null {
  registerInline(name, processor);
  if (queueModeSync() !== "redis") return null;
  const worker = new Worker(name, (job) => safeRun(name, job, processor), {
    connection: redisConnection(),
    concurrency: opts.concurrency ?? 4,
    limiter: { max: 20, duration: 1000 },
  });
  worker.on("failed", (job, err) => {
    ledgerFail((job?.data as any)?.ledgerId, err);
  });
  return worker;
}

export function queueHealth() {
  const counts = one<any>(
    `SELECT
       SUM(CASE WHEN state = 'queued' OR state = 'delayed' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM job_runs`,
  );
  return {
    mode: queueModeSync(),
    redisUrl: env.redisUrl.replace(/:\/\/[^@]*@/, "://***@"),
    waiting: Number(counts?.waiting ?? 0),
    active: Number(counts?.active ?? 0),
    failed: Number(counts?.failed ?? 0),
    completed: Number(counts?.completed ?? 0),
  };
}
