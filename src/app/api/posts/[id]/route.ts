import { one, run, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { schedulePost, cancelPost, retryPost, publishPost, postById } from "@/lib/publishing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole();
  const { id } = await ctx.params;
  const post = one<any>(
    `SELECT p.*, a.platform, a.handle, a.display_name FROM posts p
     JOIN accounts a ON a.id = p.account_id WHERE p.id = ?`,
    id,
  );
  if (!post) return fail(404, "post not found");
  const jobs = require("@/lib/db").all(
    "SELECT id, queue, job_name, state, attempts, error, created_at, finished_at FROM job_runs WHERE ref_id = ? ORDER BY created_at DESC LIMIT 10",
    id,
  );
  return ok({
    ...post,
    media: json<any[]>(post.media_json, []),
    metrics: json<Record<string, unknown>>(post.metrics_json, {}),
    jobs,
  });
});

/** Actions on one post. Body: { action: schedule|publish|cancel|retry|update } */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole();
  const { id } = await ctx.params;
  const body = await readJson<{
    action?: "schedule" | "publish" | "cancel" | "retry" | "update";
    scheduledAt?: string | null;
    body?: string;
    title?: string;
    linkUrl?: string | null;
    media?: { mediaId: string; alt?: string }[];
    kind?: string;
  }>(req);

  const post = postById(id);
  if (!post) return fail(404, "post not found");

  switch (body.action) {
    case "update": {
      if (post.status === "published" || post.status === "publishing") return fail(400, "cannot edit a post that is already publishing");
      run(
        `UPDATE posts SET body = COALESCE(?, body), title = COALESCE(?, title), link_url = COALESCE(?, link_url),
           kind = COALESCE(?, kind), media_json = COALESCE(?, media_json), updated_at = datetime('now') WHERE id = ?`,
        body.body ?? null,
        body.title ?? null,
        body.linkUrl ?? null,
        body.kind ?? null,
        body.media ? JSON.stringify(body.media) : null,
        id,
      );
      audit({ userId: user.id, action: "post.updated", entity: "post", entityId: id });
      return ok({ updated: true });
    }
    case "schedule": {
      const res = await schedulePost(id, body.scheduledAt ?? post.scheduled_at);
      audit({ userId: user.id, action: "post.schedule.requested", entity: "post", entityId: id, detail: res });
      return ok(res);
    }
    case "publish": {
      run("UPDATE posts SET status = 'queued', updated_at = datetime('now') WHERE id = ?", id);
      const res = await publishPost(id);
      audit({ userId: user.id, action: "post.publish.requested", entity: "post", entityId: id, detail: res });
      return ok(res);
    }
    case "cancel": {
      await cancelPost(id);
      return ok({ cancelled: true });
    }
    case "retry": {
      const jobId = await retryPost(id);
      return ok({ jobId });
    }
    default:
      return fail(400, "unknown action");
  }
});

export const DELETE = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole();
  const { id } = await ctx.params;
  const post = postById(id);
  if (!post) return fail(404, "post not found");
  if (post.status === "published") return fail(400, "published posts are kept as history");
  run("DELETE FROM posts WHERE id = ?", id);
  audit({ userId: user.id, action: "post.deleted", entity: "post", entityId: id });
  return ok({ deleted: id });
});
