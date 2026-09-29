import { all, one, run, uid, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson, parsePaging } from "@/lib/api";
import { schedulePost } from "@/lib/publishing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const { limit, offset, params } = parsePaging(req.url, { limit: 60 });
  const status = params.get("status");
  const platform = params.get("platform");
  const accountId = params.get("accountId");

  const where: string[] = [];
  const values: unknown[] = [];
  if (status) (where.push("p.status = ?"), values.push(status));
  if (platform) (where.push("a.platform = ?"), values.push(platform));
  if (accountId) (where.push("p.account_id = ?"), values.push(accountId));

  const posts = all<any>(
    `SELECT p.id, p.account_id, p.kind, p.body, p.title, p.media_json, p.link_url, p.scheduled_at, p.status,
            p.attempts, p.last_error, p.external_id, p.permalink, p.metrics_json, p.campaign, p.created_at, p.updated_at,
            a.platform, a.handle, a.display_name
     FROM posts p JOIN accounts a ON a.id = p.account_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY COALESCE(p.scheduled_at, p.updated_at) DESC LIMIT ? OFFSET ?`,
    ...values,
    limit,
    offset,
  ).map((p) => ({
    ...p,
    media: json<any[]>(p.media_json, []),
    metrics: json<Record<string, unknown>>(p.metrics_json, {}),
    media_json: undefined,
    metrics_json: undefined,
  }));

  const counts = one<any>(
    `SELECT
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
       SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'publishing' THEN 1 ELSE 0 END) AS publishing,
       SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
     FROM posts`,
  );

  return ok({ posts, counts });
});

export const POST = route(async (req: Request) => {
  const user = await requireRole();
  const body = await readJson<{
    accountId?: string;
    kind?: string;
    body?: string;
    title?: string;
    media?: { mediaId: string; alt?: string }[];
    linkUrl?: string;
    scheduledAt?: string | null;
    campaign?: string;
    publishNow?: boolean;
  }>(req);

  if (!body.accountId) return fail(400, "accountId is required");
  if (!body.body?.trim() && !(body.media?.length ?? 0)) return fail(400, "a post needs text or media");
  const account = one<{ id: string; platform: string; status: string }>(
    "SELECT id, platform, status FROM accounts WHERE id = ?",
    body.accountId,
  );
  if (!account) return fail(404, "account not found");
  if (account.status === "revoked") return fail(400, "account is revoked; reconnect it first");

  const id = uid("pst");
  run(
    `INSERT INTO posts (id, account_id, kind, body, title, media_json, link_url, scheduled_at, status, campaign, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    id,
    body.accountId,
    body.kind ?? "text",
    body.body ?? "",
    body.title ?? null,
    JSON.stringify(body.media ?? []),
    body.linkUrl ?? null,
    body.scheduledAt ?? null,
    body.campaign ?? null,
    user.id,
  );
  audit({ userId: user.id, action: "post.created", entity: "post", entityId: id, detail: { platform: account.platform, kind: body.kind } });

  if (body.scheduledAt || body.publishNow) {
    const when = body.publishNow ? new Date().toISOString() : body.scheduledAt!;
    const res = await schedulePost(id, when);
    return ok({ id, ...res }, { status: 201 });
  }
  return ok({ id, status: "draft" }, { status: 201 });
});
