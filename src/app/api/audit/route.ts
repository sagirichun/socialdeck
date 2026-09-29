import { all } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, route, parsePaging } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const { limit, offset, params } = parsePaging(req.url, { limit: 80 });
  const action = params.get("action");
  const entity = params.get("entity");

  const logs = all(
    `SELECT id, user_id, actor, action, entity, entity_id, detail_json, ip, ts FROM audit_logs
     ${action ? "WHERE action LIKE ?" : entity ? "WHERE entity = ?" : ""}
     ORDER BY ts DESC LIMIT ? OFFSET ?`,
    ...(action ? [`%${action}%`] : entity ? [entity] : []),
    limit,
    offset,
  );

  const actions = all<{ action: string; count: number }>(
    "SELECT action, COUNT(*) AS count FROM audit_logs GROUP BY action ORDER BY count DESC LIMIT 40",
  );
  const actors = all<{ actor: string; count: number }>(
    "SELECT actor, COUNT(*) AS count FROM audit_logs GROUP BY actor ORDER BY count DESC LIMIT 20",
  );

  return ok({ logs, actions, actors });
});
