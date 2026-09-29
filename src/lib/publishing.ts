import { all, one, run, uid, json, audit } from "./db";
import { env } from "./env";
import { getAdapter, loadAccount, refreshAccountToken, TokenRefreshRequired, type AccountRef, type MediaRef } from "./platforms";
import { resolveMedia } from "./media";
import { enqueue, QUEUE } from "./queue";

export interface PostRow {
  id: string;
  account_id: string;
  kind: string;
  body: string;
  title: string | null;
  media_json: string;
  link_url: string | null;
  scheduled_at: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  external_id: string | null;
  permalink: string | null;
  metrics_json: string;
  campaign: string | null;
}

export function postById(id: string) {
  return one<PostRow>("SELECT * FROM posts WHERE id = ?", id);
}

/**
 * Schedule a post: the DB row is the source of truth, BullMQ holds the timer so restarts
 * are survivable. Drafts can be scheduled immediately or up to any future date.
 */
export async function schedulePost(postId: string, whenIso?: string | null) {
  const post = postById(postId);
  if (!post) throw new Error("post not found");
  const account = one<any>("SELECT id, platform, status FROM accounts WHERE id = ?", post.account_id);
  if (!account) throw new Error("account not found");
  if (account.status === "revoked") throw new Error("account is revoked; reconnect it before scheduling");

  const scheduledAt = whenIso ?? post.scheduled_at ?? new Date().toISOString();
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  run(
    "UPDATE posts SET status = ?, scheduled_at = ?, updated_at = datetime('now'), last_error = NULL WHERE id = ?",
    delay > 0 ? "scheduled" : "queued",
    scheduledAt,
    postId,
  );
  await enqueue({
    queue: QUEUE.publish,
    name: "publish-post",
    data: { postId },
    delayMs: delay,
    refTable: "posts",
    refId: postId,
    jobId: `post-${postId}`, // one active publish job per post
  });
  audit({ actor: "system", action: "post.scheduled", entity: "post", entityId: postId, detail: { scheduledAt, delay } });
  return { postId, scheduledAt, delay };
}

export async function cancelPost(postId: string) {
  run(
    "UPDATE posts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','scheduled','queued','failed')",
    postId,
  );
  audit({ actor: "system", action: "post.cancelled", entity: "post", entityId: postId });
}

export interface PublishOutcome {
  ok: boolean;
  externalId?: string;
  permalink?: string;
  simulated: boolean;
  error?: string;
  attempts: number;
}

/** The actual publish call. Sandbox mode records the intent without touching a live endpoint. */
export async function publishPost(postId: string): Promise<PublishOutcome> {
  const post = postById(postId);
  if (!post) throw new Error("post not found");
  if (post.status === "cancelled") return { ok: false, simulated: false, error: "cancelled", attempts: post.attempts };

  run("UPDATE posts SET status = 'publishing', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?", postId);

  const mediaIds = json<{ mediaId: string }[]>(post.media_json, []).map((m) => m.mediaId);
  const media = resolveMedia(mediaIds) as MediaRef[];

  if (env.outboundMode === "sandbox") {
    const externalId = `sandbox_${uid("")}`;
    run(
      `UPDATE posts SET status = 'published', external_id = ?, permalink = ?, last_error = NULL,
        metrics_json = ?, updated_at = datetime('now') WHERE id = ?`,
      externalId,
      `https://sandbox.local/post/${externalId}`,
      JSON.stringify({ simulated: true, at: new Date().toISOString(), mediaCount: media.length }),
      postId,
    );
    audit({ actor: "system", action: "post.published", entity: "post", entityId: postId, detail: { externalId, simulated: true } });
    return { ok: true, externalId, permalink: `https://sandbox.local/post/${externalId}`, simulated: true, attempts: post.attempts + 1 };
  }

  let account = loadAccount(post.account_id) as AccountRef | null;
  if (!account) throw new Error("account not found");
  const adapter = getAdapter(account.platform);

  const attempt = async (acc: AccountRef) =>
    adapter.publish({
      account: acc,
      kind: post.kind as any,
      body: post.body,
      title: post.title,
      linkUrl: post.link_url,
      media,
    });

  try {
    let result;
    try {
      result = await attempt(account);
    } catch (err) {
      if (err instanceof TokenRefreshRequired) {
        account = (await refreshAccountToken(post.account_id)) as AccountRef;
        result = await attempt(account);
      } else {
        throw err;
      }
    }
    run(
      `UPDATE posts SET status = 'published', external_id = ?, permalink = ?, last_error = NULL,
        metrics_json = ?, updated_at = datetime('now') WHERE id = ?`,
      result.externalId,
      result.permalink ?? null,
      JSON.stringify({ raw: result.raw ?? null, at: new Date().toISOString() }).slice(0, 4000),
      postId,
    );
    audit({ actor: "system", action: "post.published", entity: "post", entityId: postId, detail: { externalId: result.externalId } });
    return { ok: true, externalId: result.externalId, permalink: result.permalink, simulated: false, attempts: post.attempts + 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      "UPDATE posts SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?",
      message.slice(0, 2000),
      postId,
    );
    audit({ actor: "system", action: "post.failed", entity: "post", entityId: postId, detail: { error: message } });
    return { ok: false, error: message, simulated: false, attempts: post.attempts + 1 };
  }
}

export function retryPost(postId: string) {
  const post = postById(postId);
  if (!post) throw new Error("post not found");
  if (!["failed", "cancelled"].includes(post.status)) throw new Error(`cannot retry a ${post.status} post`);
  run("UPDATE posts SET status = 'queued', last_error = NULL, updated_at = datetime('now') WHERE id = ?", postId);
  return enqueue({ queue: QUEUE.publish, name: "publish-post", data: { postId }, refTable: "posts", refId: postId });
}

/** Draft generator used by the composer's "write for me" action. */
export { };

export function upcomingBatch(limit = 20) {
  return all(
    `SELECT p.id, p.status, p.scheduled_at, p.kind, p.body, a.platform, a.handle
     FROM posts p JOIN accounts a ON a.id = p.account_id
     WHERE p.status IN ('draft','scheduled','queued','publishing')
     ORDER BY COALESCE(p.scheduled_at, p.created_at) LIMIT ?`,
    limit,
  );
}
