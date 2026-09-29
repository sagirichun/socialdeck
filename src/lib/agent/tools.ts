import { complete, type ChatMessage } from "../ai";
import { all, one, run, uid, json, audit } from "../db";
import {
  postById,
  schedulePost,
  publishPost,
  cancelPost,
  retryPost,
  upcomingBatch,
} from "../publishing";
import { ingestComment, draftForComment, sendReply, syncComments, rejectReply, inboxCounts } from "../replies";
import { metricsSnapshot, answerFromMetrics } from "../ai";
import { listStreams, startStream, stopStream, testIngest, runningStreams } from "../streams";
import { createVariant, mediaList, ASPECT_PRESETS } from "../media";
import { queueHealth } from "../queue";

/**
 * The agent executes the same operations the UI exposes, through one schema-checked tool layer.
 * Anything that changes the outside world is marked `mutating` so the caller can gate it on
 * autonomy level instead of trusting the model to police itself.
 */
export interface ToolContext {
  autonomy: "suggest" | "supervised" | "autonomous";
  userId: string | null;
  providerId?: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  mutating: boolean;
  parameters: { name: string; type: "string" | "number" | "boolean" | "array"; required: boolean; description: string }[];
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export const TOOLS: ToolDef[] = [
  {
    name: "read_metrics",
    description: "Read the current operations snapshot: accounts, queue, published counts, inbound volume, sentiment, live streams.",
    mutating: false,
    parameters: [],
    run: async () => metricsSnapshot(),
  },
  {
    name: "list_upcoming",
    description: "List drafts and scheduled posts in publication order.",
    mutating: false,
    parameters: [{ name: "limit", type: "number", required: false, description: "max rows, default 20" }],
    run: async (a) => upcomingBatch(Number(a.limit) || 20),
  },
  {
    name: "list_inbox",
    description: "List recent inbound messages with sentiment, intent, risk and whether a reply is waiting.",
    mutating: false,
    parameters: [
      { name: "hours", type: "number", required: false, description: "lookback window in hours, default 48" },
      { name: "risk", type: "string", required: false, description: "filter: none|sensitive|crisis|spam" },
    ],
    run: async (a) => {
      const hours = Number(a.hours) || 48;
      const risk = s(a.risk);
      return all(
        `SELECT c.id, c.platform, c.author_handle, substr(c.body,1,220) AS body, c.sentiment, c.intent, c.risk,
                c.received_at, (SELECT status FROM replies r WHERE r.comment_id = c.id ORDER BY created_at DESC LIMIT 1) AS reply_status
         FROM comments c
         WHERE c.received_at >= datetime('now', ?) ${risk ? "AND c.risk = ?" : ""}
         ORDER BY c.received_at DESC LIMIT 60`,
        `-${hours} hour`,
        ...(risk ? [risk] : []),
      );
    },
  },
  {
    name: "list_accounts",
    description: "List connected accounts with platform, handle, status and token expiry.",
    mutating: false,
    parameters: [],
    run: async () =>
      all(
        `SELECT a.id, a.platform, a.handle, a.status, a.token_expires_at,
                (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'published') AS published
         FROM accounts a ORDER BY a.platform, a.handle`,
      ),
  },
  {
    name: "list_streams",
    description: "List configured 24/7 RTMP relays with state, uptime and restart count.",
    mutating: false,
    parameters: [],
    run: async () =>
      listStreams().map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform,
        state: r.state,
        uptimeS: r.uptime_s,
        restarts: r.restart_count,
        lastError: r.last_error,
      })),
  },
  {
    name: "list_media",
    description: "List the media library with dimensions and duration.",
    mutating: false,
    parameters: [{ name: "limit", type: "number", required: false, description: "max rows, default 40" }],
    run: async (a) =>
      mediaList(Number(a.limit) || 40).map((m) => ({
        id: m.id,
        filename: m.filename,
        mime: m.mime,
        bytes: m.bytes,
        durationS: m.duration_s,
      })),
  },
  {
    name: "queue_health",
    description: "Report queue depth, failures and whether the Redis-backed worker or the inline fallback is active.",
    mutating: false,
    parameters: [],
    run: async () => ({ ...queueHealth(), inbox: inboxCounts(), live: runningStreams() }),
  },
  {
    name: "draft_post",
    description:
      "Create a draft post for one account. Writes the copy with the configured AI provider when body is empty. Does not publish.",
    mutating: true,
    parameters: [
      { name: "accountId", type: "string", required: true, description: "target account id" },
      { name: "brief", type: "string", required: true, description: "what the post should say" },
      { name: "kind", type: "string", required: false, description: "text|image|video, default text" },
      { name: "mediaIds", type: "array", required: false, description: "media ids to attach" },
    ],
    run: async (a, ctx) => {
      const account = one<any>("SELECT * FROM accounts WHERE id = ?", s(a.accountId));
      if (!account) throw new Error(`account ${a.accountId} not found`);
      const mediaIds = Array.isArray(a.mediaIds) ? a.mediaIds.map(String) : [];
      let body = s(a.body);
      let model: string | null = null;
      if (!body) {
        const res = await complete(
          [
            {
              role: "system",
              content:
                "You write social media copy for a brand account. No emojis, no hashtags unless asked, no preamble, maximum 3 short sentences, output the post text only.",
            },
            {
              role: "user",
              content: `platform: ${account.platform}\naccount: ${account.handle ?? "unknown"}\nbrief: ${s(a.brief)}`,
            },
          ],
          { providerId: ctx.providerId, temperature: 0.7, maxTokens: 300 },
        );
        body = res.text;
        model = res.model;
      }
      const id = uid("pst");
      run(
        `INSERT INTO posts (id, account_id, kind, body, media_json, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
        id,
        account.id,
        s(a.kind) || "text",
        body,
        JSON.stringify(mediaIds.map((mediaId) => ({ mediaId }))),
        ctx.userId,
      );
      audit({ userId: ctx.userId, actor: "agent", action: "post.drafted", entity: "post", entityId: id, detail: { model } });
      return { postId: id, body };
    },
  },
  {
    name: "schedule_post",
    description: "Move a draft into the publish queue, optionally at a future ISO timestamp.",
    mutating: true,
    parameters: [
      { name: "postId", type: "string", required: true, description: "post id" },
      { name: "scheduledAt", type: "string", required: false, description: "ISO timestamp, omit to publish now" },
    ],
    run: async (a, ctx) => {
      const res = await schedulePost(s(a.postId), s(a.scheduledAt) || null);
      audit({ userId: ctx.userId, actor: "agent", action: "post.schedule", entity: "post", entityId: s(a.postId) });
      return res;
    },
  },
  {
    name: "cancel_post",
    description: "Cancel a draft, scheduled or queued post.",
    mutating: true,
    parameters: [{ name: "postId", type: "string", required: true, description: "post id" }],
    run: async (a, ctx) => {
      await cancelPost(s(a.postId));
      return { cancelled: s(a.postId) };
    },
  },
  {
    name: "retry_post",
    description: "Re-queue a failed post.",
    mutating: true,
    parameters: [{ name: "postId", type: "string", required: true, description: "post id" }],
    run: async (a) => ({ jobId: await retryPost(s(a.postId)) }),
  },
  {
    name: "publish_post_now",
    description: "Publish a post immediately, bypassing the queue timer.",
    mutating: true,
    parameters: [{ name: "postId", type: "string", required: true, description: "post id" }],
    run: async (a, ctx) => {
      const res = await publishPost(s(a.postId));
      audit({ userId: ctx.userId, actor: "agent", action: "post.publish_now", entity: "post", entityId: s(a.postId), detail: res });
      return res;
    },
  },
  {
    name: "approve_reply",
    description: "Approve and send a pending AI-drafted reply.",
    mutating: true,
    parameters: [{ name: "replyId", type: "string", required: true, description: "reply id" }],
    run: async (a, ctx) => {
      const res = await sendReply(s(a.replyId));
      audit({ userId: ctx.userId, actor: "agent", action: "reply.approve", entity: "reply", entityId: s(a.replyId), detail: res });
      return res;
    },
  },
  {
    name: "reject_reply",
    description: "Reject a pending reply and record it as a negative style example.",
    mutating: true,
    parameters: [
      { name: "replyId", type: "string", required: true, description: "reply id" },
      { name: "reason", type: "string", required: false, description: "why it was rejected" },
    ],
    run: async (a, ctx) => {
      rejectReply(s(a.replyId), s(a.reason) || undefined);
      return { rejected: s(a.replyId) };
    },
  },
  {
    name: "draft_reply_for_comment",
    description: "Ask the AI layer for a reply to one inbound comment and store it as a suggestion.",
    mutating: true,
    parameters: [{ name: "commentId", type: "string", required: true, description: "comment id" }],
    run: async (a) => draftForComment(s(a.commentId)),
  },
  {
    name: "sync_inbox",
    description: "Pull the latest comments or mentions for one account from the platform.",
    mutating: true,
    parameters: [
      { name: "accountId", type: "string", required: true, description: "account id" },
      { name: "sinceHours", type: "number", required: false, description: "lookback, default 24" },
    ],
    run: async (a) => {
      const hours = Number(a.sinceHours) || 24;
      return syncComments(s(a.accountId), new Date(Date.now() - hours * 3600_000).toISOString());
    },
  },
  {
    name: "ingest_comment",
    description: "Record one inbound message (used by webhook tests and by operators pasting a message).",
    mutating: true,
    parameters: [
      { name: "accountId", type: "string", required: true, description: "account id" },
      { name: "externalId", type: "string", required: true, description: "platform message id" },
      { name: "body", type: "string", required: true, description: "message text" },
      { name: "authorHandle", type: "string", required: false, description: "author handle" },
    ],
    run: async (a) => {
      const account = one<any>("SELECT platform FROM accounts WHERE id = ?", s(a.accountId));
      if (!account) throw new Error("account not found");
      const res = ingestComment(s(a.accountId), {
        platform: account.platform,
        externalId: s(a.externalId),
        body: s(a.body),
        authorHandle: s(a.authorHandle) || null,
      });
      return res;
    },
  },
  {
    name: "start_stream",
    description: "Start a configured 24/7 RTMP relay.",
    mutating: true,
    parameters: [{ name: "streamId", type: "string", required: true, description: "stream id" }],
    run: async (a, ctx) => {
      const res = await startStream(s(a.streamId), ctx.userId ? `user:${ctx.userId}` : "agent");
      audit({ userId: ctx.userId, actor: "agent", action: "stream.start.requested", entity: "stream", entityId: s(a.streamId) });
      return res;
    },
  },
  {
    name: "stop_stream",
    description: "Stop a running RTMP relay.",
    mutating: true,
    parameters: [{ name: "streamId", type: "string", required: true, description: "stream id" }],
    run: async (a, ctx) => {
      const res = await stopStream(s(a.streamId), ctx.userId ? `user:${ctx.userId}` : "agent", "agent");
      audit({ userId: ctx.userId, actor: "agent", action: "stream.stop.requested", entity: "stream", entityId: s(a.streamId) });
      return res;
    },
  },
  {
    name: "test_ingest",
    description: "Push a five second synthetic test pattern to a relay's ingest endpoint to verify credentials.",
    mutating: true,
    parameters: [{ name: "streamId", type: "string", required: true, description: "stream id" }],
    run: async (a) => testIngest(s(a.streamId)),
  },
  {
    name: "generate_variant",
    description: "Create a cropped aspect-ratio variant of a video asset for cross-posting.",
    mutating: true,
    parameters: [
      { name: "mediaId", type: "string", required: true, description: "source video id" },
      { name: "aspect", type: "string", required: true, description: `one of ${Object.keys(ASPECT_PRESETS).join(", ")}` },
    ],
    run: async (a, ctx) => {
      const aspect = s(a.aspect) as keyof typeof ASPECT_PRESETS;
      if (!ASPECT_PRESETS[aspect]) throw new Error(`aspect must be one of ${Object.keys(ASPECT_PRESETS).join(", ")}`);
      const row = await createVariant(s(a.mediaId), aspect, ctx.userId);
      return { mediaId: row.id, filename: row.filename };
    },
  },
  {
    name: "answer_question",
    description: "Answer a question about the current operational state, grounded only in the stored data.",
    mutating: false,
    parameters: [{ name: "question", type: "string", required: true, description: "question text" }],
    run: async (a, ctx) => {
      const res = await answerFromMetrics(s(a.question), ctx.providerId);
      return { answer: res.text, model: res.model };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export function toolCatalog() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    mutating: t.mutating,
    parameters: t.parameters,
  }));
}

/** Render the tool catalogue for the planner prompt. */
export function catalogForPrompt() {
  return TOOLS.map((t) => {
    const params = t.parameters.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ");
    return `- ${t.name}(${params})${t.mutating ? " [mutating]" : ""}: ${t.description}`;
  }).join("\n");
}

export const AUTONOMY = {
  suggest: { mutating: false, describe: "propose steps only, execute nothing" },
  supervised: { mutating: true, describe: "execute read-only steps and park mutations for approval" },
  autonomous: { mutating: true, describe: "execute everything allowed by policy" },
} as const;

export function gate(tool: ToolDef, ctx: ToolContext) {
  if (!tool.mutating) return { allowed: true as const };
  if (ctx.autonomy === "suggest") return { allowed: false as const, reason: "autonomy is suggest-only" };
  if (ctx.autonomy === "supervised") {
    return { allowed: false as const, requiresApproval: true, reason: "awaiting operator approval" };
  }
  return { allowed: true as const };
}

export { json as parseJson };
