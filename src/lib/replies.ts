import { all, one, run, uid, json, audit } from "./db";
import { env } from "./env";
import { classifyMessage, draftReply, defaultProvider } from "./ai";
import { getAdapter, loadAccount } from "./platforms";
import { enqueue, QUEUE } from "./queue";

export interface CommentRow {
  id: string;
  account_id: string;
  platform: string;
  external_id: string;
  parent_external_id: string | null;
  thread_kind: string;
  post_external_id: string | null;
  author_handle: string | null;
  author_name: string | null;
  body: string;
  sentiment: number | null;
  intent: string | null;
  language: string | null;
  risk: string;
  received_at: string;
}

export interface RuleRow {
  id: string;
  account_id: string | null;
  name: string;
  enabled: number;
  tone: string;
  languages: string;
  system_prompt: string;
  provider_id: string | null;
  auto_send: number;
  delay_seconds: number;
  max_per_hour: number;
  sentiment_floor: number;
  escalate_keywords: string;
  blocked_topics: string;
  quiet_hours: string;
}

/* ------------------------------- ingestion -------------------------------- */

/** Idempotent ingest: webhook deliveries and pollers can both call this. */
export function ingestComment(accountId: string, item: {
  platform: string;
  externalId: string;
  parentExternalId?: string | null;
  threadKind?: string;
  postExternalId?: string | null;
  authorHandle?: string | null;
  authorName?: string | null;
  body: string;
  receivedAt?: string;
}) {
  const existing = one<{ id: string }>(
    "SELECT id FROM comments WHERE platform = ? AND external_id = ?",
    item.platform,
    item.externalId,
  );
  if (existing) return { id: existing.id, created: false };

  const id = uid("cmt");
  run(
    `INSERT INTO comments (id, account_id, platform, external_id, parent_external_id, thread_kind, post_external_id,
       author_handle, author_name, body, received_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    accountId,
    item.platform,
    item.externalId,
    item.parentExternalId ?? null,
    item.threadKind ?? "comment",
    item.postExternalId ?? null,
    item.authorHandle ?? null,
    item.authorName ?? null,
    item.body,
    item.receivedAt ?? new Date().toISOString(),
    JSON.stringify(item),
  );
  return { id, created: true };
}

/** Queue classification + drafting for a freshly ingested comment. */
export async function processComment(commentId: string) {
  const comment = one<CommentRow>("SELECT * FROM comments WHERE id = ?", commentId);
  if (!comment) return;

  if (comment.sentiment === null) {
    try {
      const cls = await classifyMessage(comment.body);
      run(
        "UPDATE comments SET sentiment = ?, intent = ?, language = ?, risk = ? WHERE id = ?",
        cls.sentiment,
        cls.intent,
        cls.language,
        cls.risk,
        commentId,
      );
      Object.assign(comment, { sentiment: cls.sentiment, intent: cls.intent, language: cls.language, risk: cls.risk });
    } catch (err) {
      // Classification failure must not drop the inbound item.
      audit({ actor: "system", action: "comment.classify.failed", entity: "comment", entityId: commentId, detail: { error: String(err) } });
    }
  }

  return draftForComment(commentId);
}

function matchRule(comment: CommentRow): RuleRow | null {
  return (
    one<RuleRow>("SELECT * FROM ai_rules WHERE account_id = ? AND enabled = 1 ORDER BY name LIMIT 1", comment.account_id) ??
    one<RuleRow>("SELECT * FROM ai_rules WHERE account_id IS NULL AND enabled = 1 ORDER BY name LIMIT 1")
  );
}

function inQuietHours(window: string, at = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return false;
  const [_, sh, sm, eh, em] = m;
  const cur = at.getHours() * 60 + at.getMinutes();
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

function containsAny(haystack: string, csv: string) {
  const needles = csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const low = haystack.toLowerCase();
  return needles.filter((n) => low.includes(n));
}

/**
 * Decide whether to draft, hold for approval, or escalate; then produce the draft.
 * Deliberately deterministic before the model is consulted: policy decides, the model writes.
 */
export async function draftForComment(commentId: string) {
  const comment = one<CommentRow>("SELECT * FROM comments WHERE id = ?", commentId);
  if (!comment) throw new Error("comment not found");
  if (comment.thread_kind === "comment" && !comment.body.trim()) return null;

  const rule = matchRule(comment);
  if (!rule) return null;

  const block = (reason: string, mode = "escalate") => {
    const id = uid("rep");
    run(
      `INSERT INTO replies (id, comment_id, account_id, mode, body, status, error)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
      id,
      commentId,
      comment.account_id,
      mode,
      mode === "escalate" ? "blocked" : "rejected",
      reason,
    );
    audit({ actor: "system", action: "reply.blocked", entity: "comment", entityId: commentId, detail: { reason } });
    return { id, blocked: reason };
  };

  if (comment.risk === "spam") return block("classified as spam", "auto");
  if (comment.risk === "crisis") return block("crisis keyword - routed to human");
  if ((comment.sentiment ?? 0) < rule.sentiment_floor) {
    return block(`sentiment ${comment.sentiment?.toFixed(2)} below floor ${rule.sentiment_floor}`);
  }
  const escalated = containsAny(comment.body, rule.escalate_keywords);
  if (escalated.length) return block(`escalation keyword: ${escalated.join(", ")}`);
  const blocked = containsAny(comment.body, rule.blocked_topics);
  if (blocked.length) return block(`blocked topic: ${blocked.join(", ")}`);

  const already = one<{ id: string; status: string }>(
    "SELECT id, status FROM replies WHERE comment_id = ? AND status IN ('pending','approved','sent')",
    commentId,
  );
  if (already) return { id: already.id, skipped: `reply already ${already.status}` };

  const hourCount = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM replies WHERE account_id = ? AND created_at >= datetime('now','-1 hour')",
    comment.account_id,
  )?.n ?? 0;
  if (hourCount >= rule.max_per_hour) {
    return block(`hourly auto-reply limit (${rule.max_per_hour}) reached`, "suggested");
  }

  const account = one<any>("SELECT handle, platform, meta_json FROM accounts WHERE id = ?", comment.account_id);
  const history = all<{ inbound: string; outbound: string }>(
    `SELECT c.body AS inbound, r.body AS outbound FROM replies r JOIN comments c ON c.id = r.comment_id
     WHERE r.account_id = ? AND r.status = 'sent' AND r.body <> '' ORDER BY r.sent_at DESC LIMIT 4`,
    comment.account_id,
  );

  const provider = rule.provider_id ?? defaultProvider()?.id ?? null;
  let draft: { text: string; model: string; providerId: string };
  try {
    const res = await draftReply({
      accountHandle: account?.handle ?? null,
      platform: account?.platform ?? comment.platform,
      brandGuidance: rule.system_prompt,
      tone: rule.tone,
      language: comment.language ?? rule.languages.split(",")[0],
      inboundAuthor: comment.author_handle,
      inboundBody: comment.body,
      history,
      providerId: provider,
    });
    draft = { text: res.text, model: res.model, providerId: res.providerId };
  } catch (err) {
    const id = uid("rep");
    run(
      `INSERT INTO replies (id, comment_id, account_id, mode, body, status, error, provider_id, model)
       VALUES (?, ?, ?, 'suggested', '', 'failed', ?, ?, NULL)`,
      id,
      commentId,
      comment.account_id,
      String(err).slice(0, 500),
      provider,
    );
    throw err;
  }

  if (/^ESCALATE/i.test(draft.text)) return block("model flagged for human handling");
  if (/^SPAM/i.test(draft.text)) return block("model classified as spam", "auto");

  const autoSend = rule.auto_send === 1 && !inQuietHours(rule.quiet_hours);
  const id = uid("rep");
  run(
    `INSERT INTO replies (id, comment_id, account_id, mode, body, status, provider_id, model, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    commentId,
    comment.account_id,
    rule.auto_send === 1 ? "auto" : "suggested",
    draft.text,
    autoSend ? "approved" : "pending",
    draft.providerId,
    draft.model,
    0.7,
  );

  if (autoSend) {
    await enqueue({
      queue: QUEUE.reply,
      name: "send-reply",
      data: { replyId: id },
      delayMs: Math.max(0, rule.delay_seconds * 1000),
      refTable: "replies",
      refId: id,
    });
  } else if (rule.auto_send === 1) {
    audit({ actor: "system", action: "reply.quiet_hours", entity: "reply", entityId: id, detail: { window: rule.quiet_hours } });
  }

  audit({ actor: "system", action: "reply.drafted", entity: "reply", entityId: id, detail: { mode: autoSend ? "auto" : "suggested", model: draft.model } });
  return { id, mode: autoSend ? "auto" : "suggested", body: draft.text };
}

/* --------------------------------- sending -------------------------------- */

export async function sendReply(replyId: string) {
  const reply = one<any>("SELECT * FROM replies WHERE id = ?", replyId);
  if (!reply) throw new Error("reply not found");
  if (reply.status === "sent") return { ok: true, skipped: "already sent" };
  if (!["approved", "pending"].includes(reply.status)) throw new Error(`reply is ${reply.status}`);
  if (!reply.body.trim()) throw new Error("reply body is empty");

  const comment = one<CommentRow>("SELECT * FROM comments WHERE id = ?", reply.comment_id)!;

  if (env.outboundMode === "sandbox") {
    const externalId = `sandbox_${uid("")}`;
    run("UPDATE replies SET status = 'sent', external_id = ?, sent_at = datetime('now') WHERE id = ?", externalId, replyId);
    addExemplar(reply.account_id, comment, reply.body, 1);
    audit({ actor: "system", action: "reply.sent", entity: "reply", entityId: replyId, detail: { externalId, simulated: true } });
    return { ok: true, externalId, simulated: true };
  }

  const account = loadAccount(reply.account_id);
  if (!account) throw new Error("account not found");
  const adapter = getAdapter(account.platform);
  if (!adapter.reply) throw new Error(`${account.platform} does not support replies`);

  try {
    const res = await adapter.reply(account, comment.external_id, reply.body);
    run("UPDATE replies SET status = 'sent', external_id = ?, sent_at = datetime('now'), error = NULL WHERE id = ?", res.externalId, replyId);
    addExemplar(reply.account_id, comment, reply.body, 1);
    audit({ actor: "system", action: "reply.sent", entity: "reply", entityId: replyId, detail: { externalId: res.externalId } });
    return { ok: true, externalId: res.externalId, simulated: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run("UPDATE replies SET status = 'failed', error = ? WHERE id = ?", message.slice(0, 1000), replyId);
    audit({ actor: "system", action: "reply.failed", entity: "reply", entityId: replyId, detail: { error: message } });
    return { ok: false, error: message, simulated: false };
  }
}

/** Learning loop: sent replies become style exemplars, rejected ones negative examples. */
export function addExemplar(accountId: string, comment: CommentRow, outbound: string, score: number) {
  run(
    "INSERT INTO reply_exemplars (id, account_id, intent, inbound, outbound, score) VALUES (?, ?, ?, ?, ?, ?)",
    uid("exm"),
    accountId,
    comment.intent ?? null,
    comment.body.slice(0, 1000),
    outbound.slice(0, 1000),
    score,
  );
  const extra = one<{ n: number }>("SELECT COUNT(*) AS n FROM reply_exemplars WHERE account_id = ?", accountId)?.n ?? 0;
  if (extra > 200) {
    run(
      `DELETE FROM reply_exemplars WHERE id IN (
         SELECT id FROM reply_exemplars WHERE account_id = ? ORDER BY created_at ASC LIMIT ?
       )`,
      accountId,
      extra - 200,
    );
  }
}

export function rejectReply(replyId: string, reason?: string) {
  const reply = one<any>("SELECT r.*, c.body AS inbound FROM replies r JOIN comments c ON c.id = r.comment_id WHERE r.id = ?", replyId);
  if (!reply) throw new Error("reply not found");
  run("UPDATE replies SET status = 'rejected', error = ? WHERE id = ?", reason ?? "rejected by operator", replyId);
  if (reply.body) {
    run(
      "INSERT INTO reply_exemplars (id, account_id, intent, inbound, outbound, score) VALUES (?, ?, NULL, ?, ?, -1)",
      uid("exm"),
      reply.account_id,
      String(reply.inbound ?? "").slice(0, 1000),
      String(reply.body).slice(0, 1000),
    );
  }
  audit({ actor: "system", action: "reply.rejected", entity: "reply", entityId: replyId, detail: { reason } });
}

/** Pull the inbox for one account via the platform adapter. */
export async function syncComments(accountId: string, sinceIso?: string) {
  const account = loadAccount(accountId);
  if (!account) throw new Error("account not found");
  if (env.outboundMode === "sandbox") {
    return { ingested: 0, simulated: true, note: "sandbox mode: no platform polling" };
  }
  const adapter = getAdapter(account.platform);
  if (!adapter.fetchComments) return { ingested: 0, note: `${account.platform} has no comment API` };
  const since = sinceIso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const items = await adapter.fetchComments(account, since);
  let ingested = 0;
  for (const item of items) {
    const res = ingestComment(accountId, { platform: account.platform, ...item });
    if (res.created) {
      ingested++;
      await enqueue({ queue: QUEUE.reply, name: "process-comment", data: { commentId: res.id }, refTable: "comments", refId: res.id });
    }
  }
  run("UPDATE accounts SET last_error = NULL, updated_at = datetime('now') WHERE id = ?", accountId);
  return { ingested, total: items.length };
}

export function inboxCounts() {
  const row = one<any>(
    `SELECT
        SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM replies r WHERE r.created_at >= datetime('now','-7 day')`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    sent: Number(row?.sent ?? 0),
    blocked: Number(row?.blocked ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export { json as parseJson };
