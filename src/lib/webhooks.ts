import { all, one, run, uid, audit } from "./db";
import { verifyHmacSha256, verifyHmacBase64 } from "./crypto";
import { ingestComment } from "./replies";
import { enqueue, QUEUE } from "./queue";

/**
 * Webhook ingest for every platform that pushes rather than polled.
 * Contract: verify signature when the platform provides one, store the raw body first,
 * then process asynchronously so a slow AI call can never time out the platform's request.
 */

export type WebhookTopic = "comments" | "mentions" | "messages" | "changes" | "unknown";

export interface NormalisedWebhook {
  platform: string;
  topic: WebhookTopic;
  externalAccountId: string | null;
  items: {
    externalId: string;
    body: string;
    authorHandle?: string | null;
    authorName?: string | null;
    parentExternalId?: string | null;
    postExternalId?: string | null;
    threadKind?: "comment" | "mention" | "dm" | "review";
    receivedAt?: string;
  }[];
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function verifySignature(platform: string, rawBody: string, headers: Headers): boolean {
  const secret = process.env[`WEBHOOK_SECRET_${platform.toUpperCase()}`] || process.env.WEBHOOK_SECRET || "";
  if (!secret) return false; // never accept unsigned payloads when no secret is configured
  switch (platform) {
    case "facebook":
    case "instagram":
    case "threads": {
      return verifyHmacSha256(rawBody, headers.get("x-hub-signature-256") ?? "", secret);
    }
    case "x": {
      return verifyHmacBase64(rawBody, headers.get("x-twitter-webhooks-signature") ?? "", secret);
    }
    case "tiktok": {
      return verifyHmacSha256(rawBody, headers.get("x-tt-signature") ?? "", secret, "");
    }
    default:
      return verifyHmacSha256(rawBody, headers.get("x-signature-256") ?? headers.get("x-signature") ?? "", secret, "");
  }
}

/** Map a platform payload onto the internal inbound shape. */
export function normalise(platform: string, payload: any): NormalisedWebhook {
  const empty: NormalisedWebhook = { platform, topic: "unknown", externalAccountId: null, items: [] };

  if (platform === "facebook" || platform === "instagram" || platform === "threads") {
    const entries: any[] = payload?.entry ?? [];
    const items: NormalisedWebhook["items"] = [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        if (value?.item === "comment" && value?.comment_id) {
          items.push({
            externalId: str(value.comment_id),
            body: str(value.message),
            authorHandle: str(value.from?.username || value.from?.id),
            authorName: str(value.from?.name),
            parentExternalId: value.parent_id ? str(value.parent_id) : null,
            postExternalId: value.post_id ? str(value.post_id) : value.media?.id ? str(value.media.id) : null,
            threadKind: "comment",
            receivedAt: value.created_time ? new Date(Number(value.created_time) * 1000).toISOString() : undefined,
          });
        } else if (value?.item === "mention" && value?.comment_id) {
          items.push({
            externalId: str(value.comment_id),
            body: str(value.message),
            authorHandle: value.media?.owner?.id ? str(value.media.owner.id) : null,
            postExternalId: value.media?.id ? str(value.media.id) : null,
            threadKind: "mention",
          });
        }
      }
    }
    return { platform, topic: items.length ? (items[0].threadKind === "mention" ? "mentions" : "comments") : "changes", externalAccountId: entries[0]?.id ? str(entries[0].id) : null, items };
  }

  if (platform === "x") {
    const items = (payload?.tweet_create_events ?? []).map((t: any) => ({
      externalId: str(t.id_str ?? t.id),
      body: str(t.text),
      authorHandle: str(t.user?.screen_name),
      authorName: str(t.user?.name),
      parentExternalId: t.in_reply_to_status_id_str ? str(t.in_reply_to_status_id_str) : null,
      postExternalId: t.in_reply_to_status_id_str ? str(t.in_reply_to_status_id_str) : null,
      threadKind: "mention" as const,
      receivedAt: t.created_at ? new Date(t.created_at).toISOString() : undefined,
    }));
    return { platform, topic: "mentions", externalAccountId: str(payload?.for_user_id), items };
  }

  if (platform === "tiktok") {
    const items = (payload?.events ?? payload?.data?.events ?? []).map((e: any) => ({
      externalId: str(e.comment_id ?? e.id),
      body: str(e.comment ?? e.text),
      authorHandle: str(e.user_id),
      parentExternalId: e.parent_comment_id ? str(e.parent_comment_id) : null,
      postExternalId: e.video_id ? str(e.video_id) : null,
      threadKind: "comment" as const,
    }));
    return { platform, topic: "comments", externalAccountId: str(payload?.user_openid), items };
  }

  // Generic shape used by self-hosted bridges: { topic, account, items: [...] }
  if (Array.isArray(payload?.items)) {
    const items = payload.items.map((i: any) => ({
      externalId: str(i.externalId ?? i.id),
      body: str(i.body ?? i.text),
      authorHandle: i.authorHandle ? str(i.authorHandle) : null,
      authorName: i.authorName ? str(i.authorName) : null,
      parentExternalId: i.parentExternalId ? str(i.parentExternalId) : null,
      postExternalId: i.postExternalId ? str(i.postExternalId) : null,
      threadKind: (i.threadKind ?? "comment") as any,
      receivedAt: i.receivedAt ? str(i.receivedAt) : undefined,
    }));
    return { platform, topic: (payload?.topic as WebhookTopic) ?? "comments", externalAccountId: str(payload?.account), items };
  }

  return empty;
}

export interface IngestResult {
  eventId: string;
  accepted: number;
  duplicates: number;
  skipped: string | null;
}

/** Store then process; the HTTP handler never waits on model calls. */
export async function receiveWebhook(
  platform: string,
  rawBody: string,
  payload: any,
  meta: { signatureOk: boolean; topic?: string | null } ,
): Promise<IngestResult> {
  const eventId = uid("whk");
  const normalised = normalise(platform, payload);
  run(
    `INSERT INTO webhook_events (id, platform, topic, account_id, signature_ok, payload_json)
     VALUES (?, ?, ?, (SELECT id FROM accounts WHERE platform = ? AND external_id = ? LIMIT 1), ?, ?)`,
    eventId,
    platform,
    meta.topic ?? normalised.topic,
    platform,
    normalised.externalAccountId ?? "",
    meta.signatureOk ? 1 : 0,
    JSON.stringify(payload).slice(0, 200000),
  );

  if (!meta.signatureOk) {
    run("UPDATE webhook_events SET error = ?, processed_at = datetime('now') WHERE id = ?", "signature verification failed", eventId);
    return { eventId, accepted: 0, duplicates: 0, skipped: "signature" };
  }

  const account = normalised.externalAccountId
    ? one<{ id: string }>(
        "SELECT id FROM accounts WHERE platform = ? AND external_id = ?",
        platform,
        normalised.externalAccountId,
      )
    : null;

  if (!account) {
    // Fall back to the single connected account on that platform so small tenants still work.
    const fallback = one<{ id: string }>(
      "SELECT id FROM accounts WHERE platform = ? ORDER BY created_at LIMIT 1",
      platform,
    );
    if (!fallback) {
      run("UPDATE webhook_events SET error = ?, processed_at = datetime('now') WHERE id = ?", "no account registered for this payload", eventId);
      return { eventId, accepted: 0, duplicates: 0, skipped: "no-account" };
    }
    var accountId = fallback.id;
  } else {
    var accountId = account.id;
  }

  let accepted = 0;
  let duplicates = 0;
  for (const item of normalised.items) {
    const res = ingestComment(accountId, { platform, ...item });
    if (res.created) {
      accepted++;
      await enqueue({ queue: QUEUE.reply, name: "process-comment", data: { commentId: res.id }, refTable: "comments", refId: res.id });
    } else {
      duplicates++;
    }
  }

  run("UPDATE webhook_events SET account_id = ?, processed_at = datetime('now') WHERE id = ?", accountId, eventId);
  audit({ actor: "platform", action: "webhook.received", entity: "webhook", entityId: eventId, detail: { platform, accepted, duplicates } });
  return { eventId, accepted, duplicates, skipped: null };
}

export function webhookLog(limit = 40) {
  return all(
    `SELECT id, platform, topic, signature_ok, received_at, processed_at, error,
            substr(payload_json, 1, 240) AS preview
     FROM webhook_events ORDER BY received_at DESC LIMIT ?`,
    limit,
  );
}
