import { all, one, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, route, parsePaging } from "@/lib/api";
import { inboxCounts } from "@/lib/replies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const { limit, offset, params } = parsePaging(req.url, { limit: 50 });
  const risk = params.get("risk");
  const platform = params.get("platform");
  const accountId = params.get("accountId");
  const hasReply = params.get("hasReply");

  const where: string[] = [];
  const values: unknown[] = [];
  if (risk) (where.push("c.risk = ?"), values.push(risk));
  if (platform) (where.push("c.platform = ?"), values.push(platform));
  if (accountId) (where.push("c.account_id = ?"), values.push(accountId));
  if (hasReply === "pending") where.push("EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id AND r.status = 'pending')");
  if (hasReply === "none") where.push("NOT EXISTS (SELECT 1 FROM replies r WHERE r.comment_id = c.id AND r.status IN ('pending','approved','sent'))");

  const items = all<any>(
    `SELECT c.id, c.account_id, c.platform, c.external_id, c.thread_kind, c.post_external_id, c.author_handle,
            c.author_name, c.body, c.sentiment, c.intent, c.language, c.risk, c.received_at,
            (SELECT COUNT(*) FROM replies r WHERE r.comment_id = c.id) AS reply_count
     FROM comments c
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.received_at DESC LIMIT ? OFFSET ?`,
    ...values,
    limit,
    offset,
  );

  const withReplies = items.map((c) => ({
    ...c,
    replies: all<any>(
      `SELECT id, mode, body, status, model, confidence, error, created_at, sent_at, external_id
       FROM replies WHERE comment_id = ? ORDER BY created_at DESC`,
      c.id,
    ).map((r) => ({ ...r })),
  }));

  const sentiment = one<any>(
    `SELECT AVG(sentiment) AS avg, COUNT(*) AS n FROM comments WHERE received_at >= datetime('now','-7 day') AND sentiment IS NOT NULL`,
  );
  const byRisk = all<any>(
    `SELECT risk, COUNT(*) AS count FROM comments WHERE received_at >= datetime('now','-7 day') GROUP BY risk ORDER BY count DESC`,
  );
  const byIntent = all<any>(
    `SELECT intent, COUNT(*) AS count FROM comments WHERE received_at >= datetime('now','-7 day') GROUP BY intent ORDER BY count DESC`,
  );
  const trend = all<any>(
    `SELECT date(received_at) AS day,
            COUNT(*) AS inbound,
            AVG(sentiment) AS sentiment,
            SUM(CASE WHEN risk = 'crisis' THEN 1 ELSE 0 END) AS crisis
     FROM comments WHERE received_at >= datetime('now','-14 day')
     GROUP BY date(received_at) ORDER BY day`,
  );

  return ok({
    comments: withReplies,
    counts: inboxCounts(),
    stats: {
      sentiment7d: sentiment?.avg ?? null,
      inbound7d: sentiment?.n ?? 0,
      byRisk,
      byIntent,
      trend,
    },
  });
});
