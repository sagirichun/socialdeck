import { all, one, run } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, route, parsePaging } from "@/lib/api";
import { queueHealth } from "@/lib/queue";
import { runningStreams, streamRuntime } from "@/lib/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const { limit, offset, params } = parsePaging(req.url, { limit: 60 });
  const queue = params.get("queue");
  const state = params.get("state");

  const jobs = all<any>(
    `SELECT id, queue, job_name, ref_table, ref_id, state, attempts, error, created_at, started_at, finished_at
     FROM job_runs
     ${queue ? "WHERE queue = ?" : state ? "WHERE state = ?" : ""}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...(queue ? [queue] : state ? [state] : []),
    limit,
    offset,
  );

  const queues = all<any>(
    `SELECT queue,
            SUM(CASE WHEN state IN ('queued','delayed') THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
            MAX(created_at) AS last_activity
     FROM job_runs GROUP BY queue ORDER BY waiting DESC`,
  );

  const throughput = all<any>(
    `SELECT strftime('%H', created_at) AS hour, COUNT(*) AS jobs
     FROM job_runs WHERE created_at >= datetime('now','-1 day') GROUP BY hour ORDER BY hour`,
  );

  return ok({
    jobs,
    queues,
    throughput,
    health: streamRuntime(),
  });
});

export const DELETE = route(async (req: Request) => {
  await requireRole("owner", "admin");
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    run("DELETE FROM job_runs WHERE id = ?", id);
    return ok({ deleted: id });
  }
  run("DELETE FROM job_runs WHERE state IN ('completed','failed') AND created_at < datetime('now','-7 day')");
  return ok({ purged: true });
});
