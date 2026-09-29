import { all, one, run, uid, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reply rules are stored in a normalised shape (languages csv, max_per_hour, auto_send) and
 * published in the flat shape the console edits. The mapping lives here so no screen needs to
 * know both vocabularies.
 */
function publishRule(row: any) {
  return {
    id: row.id,
    name: row.name,
    account_id: row.account_id,
    platform: row.account_platform ?? null,
    handle: row.account_handle ?? null,
    provider_id: row.provider_id,
    provider_name: row.provider_name ?? null,
    persona: row.persona ?? null,
    tone: row.tone,
    language: row.languages,
    // A rule is "auto reply" once it is enabled; approval is the separate gate.
    auto_reply: row.enabled ? 1 : 0,
    require_approval: row.auto_send ? 0 : 1,
    escalate_keywords: String(row.escalate_keywords ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
    escalation_email: row.escalation_email ?? null,
    max_replies_per_hour: Number(row.max_per_hour ?? 0),
    enabled: row.enabled ? 1 : 0,
    updated_at: row.updated_at ?? row.created_at,
  };
}

export const GET = route(async () => {
  await requireRole();
  const rules = all<any>(
    `SELECT r.*, a.handle AS account_handle, a.platform AS account_platform, p.name AS provider_name
     FROM ai_rules r
     LEFT JOIN accounts a ON a.id = r.account_id
     LEFT JOIN ai_providers p ON p.id = r.provider_id
     ORDER BY r.account_id IS NULL DESC, r.name`,
  );
  const defaults = {
    tone: "professional",
    language: "id,en",
    requireApproval: true,
    maxRepliesPerHour: 12,
    escalateKeywords: "refund,hukum,legal,polisi,pengacara",
  };
  return ok({ rules: rules.map(publishRule), defaults });
});

export const POST = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<Record<string, any>>(req);

  // Exemplars teach the reply model a house style; they are not rules themselves.
  if (body.exemplar) {
    const ex = body.exemplar as { inbound?: string; outbound?: string; accountId?: string; tag?: string };
    if (!ex.inbound || !ex.outbound) return fail(400, "exemplar needs inbound and outbound text");
    const id = uid("exm");
    run(
      "INSERT INTO reply_exemplars (id, account_id, inbound, outbound, tag, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      ex.accountId ?? null,
      ex.inbound,
      ex.outbound,
      ex.tag ?? null,
      user.id,
    );
    audit({ userId: user.id, action: "exemplar.created", entity: "reply_exemplar", entityId: id });
    return ok({ id }, { status: 201 });
  }

  if (!body.name) return fail(400, "name is required");
  if (body.accountId && !one("SELECT 1 AS n FROM accounts WHERE id = ?", body.accountId)) return fail(404, "account not found");
  if (body.providerId && !one("SELECT 1 AS n FROM ai_providers WHERE id = ?", body.providerId)) return fail(404, "provider not found");

  const id = uid("rul");
  run(
    `INSERT INTO ai_rules (id, account_id, name, enabled, tone, languages, system_prompt, provider_id, auto_send,
       max_per_hour, escalate_keywords, persona, escalation_email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    id,
    body.accountId ?? null,
    body.name,
    body.autoReply === false ? 0 : 1,
    body.tone ?? "professional",
    body.language ?? "id,en",
    body.systemPrompt ?? "",
    body.providerId ?? null,
    body.requireApproval === false ? 1 : 0,
    Number(body.maxRepliesPerHour ?? 12),
    Array.isArray(body.escalateKeywords) ? body.escalateKeywords.join(",") : (body.escalateKeywords ?? "refund,hukum,legal,polisi,pengacara"),
    body.persona ?? null,
    body.escalationEmail ?? null,
  );
  audit({ userId: user.id, action: "rule.created", entity: "ai_rule", entityId: id, detail: { name: body.name, autoSend: body.requireApproval === false } });
  return ok({ id }, { status: 201 });
});
