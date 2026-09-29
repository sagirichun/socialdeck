import { all, one } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, route, parsePaging } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const { limit, offset, params } = parsePaging(req.url, { limit: 50 });
  const status = params.get("status");
  const rows = all<any>(
    `SELECT r.id, r.comment_id, r.account_id, r.mode, r.body, r.status, r.model, r.confidence, r.error,
            r.created_at, r.sent_at, r.external_id,
            c.platform, c.author_handle, c.body AS inbound_body, c.risk, c.sentiment, c.intent,
            a.handle AS account_handle
     FROM replies r
     JOIN comments c ON c.id = r.comment_id
     LEFT JOIN accounts a ON a.id = r.account_id
     ${status ? "WHERE r.status = ?" : ""}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    ...(status ? [status] : []),
    limit,
    offset,
  );
  return ok({ replies: rows });
});
