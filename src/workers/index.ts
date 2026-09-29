#!/usr/bin/env tsx
/**
 * Worker process: BullMQ consumers when Redis is reachable, inline timer wheel otherwise.
 * Run with: npm run worker
 */
import "@/lib/platforms"; // registers every adapter
import { migrate, audit, one, run } from "@/lib/db";
import { QUEUE, detectMode, startWorker, queueHealth } from "@/lib/queue";
import { publishPost, schedulePost, upcomingBatch, postById } from "@/lib/publishing";
import { processComment, sendReply, syncComments } from "@/lib/replies";
import { supervise, startStream, stopStream } from "@/lib/streams";
import { runGoal } from "@/lib/agent/run";
import { complete } from "@/lib/ai";
import { all } from "@/lib/db";

const log = (...parts: unknown[]) => console.log(`[worker ${new Date().toISOString()}]`, ...parts);

async function main() {
  const applied = migrate();
  if (applied.length) log("migrations applied:", applied.join(", "));
  const mode = await detectMode(true);
  log(`queue mode: ${mode}`);

  startWorker(QUEUE.publish, async (job) => {
    const { postId } = job.data as { postId: string };
    log("publish", postId);
    const res = await publishPost(postId);
    if (!res.ok) throw new Error(res.error ?? "publish failed");
    return res;
  });

  startWorker(QUEUE.reply, async (job) => {
    const data = job.data as { commentId?: string; replyId?: string };
    if (job.name === "process-comment" && data.commentId) {
      log("process-comment", data.commentId);
      return processComment(data.commentId);
    }
    if (job.name === "send-reply" && data.replyId) {
      log("send-reply", data.replyId);
      const res = await sendReply(data.replyId);
      if (!res.ok) throw new Error(res.error ?? "reply failed");
      return res;
    }
    return { skipped: job.name };
  });

  startWorker(QUEUE.stream, async (job) => {
    const { streamId, action } = job.data as { streamId: string; action: "start" | "stop" };
    log("stream", action, streamId);
    return action === "stop" ? stopStream(streamId, "worker") : startStream(streamId, "worker");
  });

  startWorker(QUEUE.metrics, async (job) => {
    const { accountId } = job.data as { accountId: string };
    return syncComments(accountId);
  });

  startWorker(
    QUEUE.agent,
    async (job) => {
      const { goal, autonomy, userId, providerId } = job.data as any;
      log("agent goal:", goal);
      return runGoal(goal, { autonomy, userId, providerId });
    },
    { concurrency: 1 },
  );

  log("queue health:", JSON.stringify(queueHealth()));

  /* ------------------------- periodic maintenance ------------------------- */

  let tick = 0;
  const interval = setInterval(async () => {
    tick++;
    try {
      await supervise();

      // Every minute: promote due posts that lost their timer to a restart.
      if (tick % 3 === 0) {
        for (const s of upcomingBatch(50) as any[]) {
          if (s.status === "scheduled" && s.scheduled_at && new Date(s.scheduled_at).getTime() <= Date.now()) {
            log("promoting due post", s.id);
            await schedulePost(s.id, new Date().toISOString());
          }
        }
        // stalled publishing rows (process died mid-flight) go back to the queue
        const stalled = all<{ id: string }>(
          "SELECT id FROM posts WHERE status = 'publishing' AND updated_at < datetime('now','-10 minute')",
        );
        for (const row of stalled) {
          log("requeueing stalled post", row.id);
          run("UPDATE posts SET status = 'queued' WHERE id = ?", row.id);
          await schedulePost(row.id, new Date().toISOString());
        }
      }

      // Every five minutes: pull inbound for accounts whose platform supports polling.
      if (tick % 15 === 0) {
        const accounts = all<{ id: string; platform: string }>(
          "SELECT id, platform FROM accounts WHERE status = 'connected'",
        );
        for (const acc of accounts) {
          try {
            const res = await syncComments(acc.id);
            if ((res as any).ingested) log("inbox sync", acc.id, res);
          } catch (err) {
            run("UPDATE accounts SET last_error = ? WHERE id = ?", String(err).slice(0, 300), acc.id);
          }
        }
      }

      // Every fifteen minutes: health probe of the default AI provider.
      if (tick % 45 === 0) {
        try {
          const provider = one<{ id: string; name: string }>(
            "SELECT id, name FROM ai_providers WHERE enabled = 1 AND is_default = 1",
          );
          if (provider) {
            await complete([{ role: "user", content: "ping" }], { providerId: provider.id, maxTokens: 8 });
          }
        } catch {
          /* last_error recorded by the ai layer */
        }
      }
    } catch (err) {
      log("maintenance error:", err instanceof Error ? err.message : err);
    }
  }, 20_000);

  const shutdown = async () => {
    log("shutting down");
    clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  audit({ actor: "system", action: "worker.started", detail: { mode } });
  log("worker ready");
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
