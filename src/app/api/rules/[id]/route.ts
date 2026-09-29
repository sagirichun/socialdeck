import { one, run, audit } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<Record<string, any>>(req);
  if (!body.id) return fail(400, "id is required");
  const existing = one<any>("SELECT * FROM ai_rules WHERE id = ?", body.id);
  if (!existing) return fail(404, "rule not found");

  run(
    `UPDATE ai_rules SET name = ?, enabled = ?, tone = ?, languages = ?, provider_id = ?,
       auto_send = ?, max_per_hour = ?, escalate_keywords = ?, persona = ?, escalation_email = ?,
       updated_at = datetime('now') WHERE id = ?`,
    body.name ?? existing.name,
    body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
    body.tone ?? existing.tone,
    body.language ?? existing.languages,
    body.providerId === undefined ? existing.provider_id : body.providerId,
    body.requireApproval === undefined ? existing.auto_send : body.requireApproval ? 0 : 1,
    Number(body.maxRepliesPerHour ?? existing.max_per_hour),
    Array.isArray(body.escalateKeywords) ? body.escalateKeywords.join(",") : (body.escalateKeywords ?? existing.escalate_keywords),
    body.persona === undefined ? existing.persona : body.persona,
    body.escalationEmail === undefined ? existing.escalation_email : body.escalationEmail,
    body.id,
  );
  audit({ userId: user.id, action: "rule.updated", entity: "ai_rule", entityId: body.id, detail: { requireApproval: body.requireApproval } });
  return ok({ updated: true });
});

export const DELETE = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail(400, "id is required");
  run("DELETE FROM ai_rules WHERE id = ?", id);
  audit({ userId: user.id, action: "rule.deleted", entity: "ai_rule", entityId: id });
  return ok({ deleted: id });
});
