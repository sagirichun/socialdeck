import { all, one, run, uid, audit } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { listProviders, testProvider, complete, answerFromMetrics } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole();
  const providers = listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.base_url,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.max_tokens,
    timeoutMs: p.timeout_ms,
    enabled: p.enabled === 1,
    isDefault: p.is_default === 1,
    keyMasked: maskSecret(decryptSecret(p.api_key_enc)),
    hasKey: Boolean(p.api_key_enc),
    lastError: (p as any).last_error ?? null,
    lastOkAt: (p as any).last_ok_at ?? null,
  }));
  return ok({
    providers,
    kinds: [
      { key: "openai", label: "OpenAI", note: "api.openai.com or any OpenAI-compatible cloud endpoint" },
      { key: "anthropic", label: "Anthropic", note: "Messages API" },
      { key: "openai-compatible", label: "OpenAI-compatible", note: "vLLM, Together, Groq, LiteLLM" },
      { key: "ollama", label: "Ollama", note: "local server, /api/chat" },
      { key: "lmstudio", label: "LM Studio", note: "local server, OpenAI-compatible" },
      { key: "router", label: "Model router", note: "internal gateway that multiplexes models" },
      { key: "custom", label: "Custom", note: "any endpoint that speaks OpenAI chat completions" },
    ],
  });
});

export const POST = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const body = await readJson<Record<string, any>>(req);

  if (body.action === "test" && body.id) {
    const res = await testProvider(body.id);
    return ok(res, { status: res.ok ? 200 : 502 });
  }

  if (body.action === "default" && body.id) {
    run("UPDATE ai_providers SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END", body.id);
    audit({ userId: user.id, action: "ai.default", entity: "ai_provider", entityId: body.id });
    return ok({ isDefault: body.id });
  }

  if (!body.name || !body.baseUrl || !body.model) return fail(400, "name, baseUrl and model are required");
  const id = uid("aip");
  const makeDefault = body.isDefault ? 1 : 0;
  if (makeDefault) run("UPDATE ai_providers SET is_default = 0");
  run(
    `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key_enc, extra_json, temperature, max_tokens, timeout_ms, enabled, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.name,
    body.kind ?? "openai",
    body.baseUrl,
    body.model,
    body.apiKey ? encryptSecret(body.apiKey) : null,
    JSON.stringify(body.extra ?? {}),
    Number(body.temperature ?? 0.4),
    Number(body.maxTokens ?? 800),
    Number(body.timeoutMs ?? 60000),
    body.enabled === false ? 0 : 1,
    makeDefault,
  );
  audit({ userId: user.id, action: "ai.created", entity: "ai_provider", entityId: id, detail: { kind: body.kind, model: body.model } });
  return ok({ id }, { status: 201 });
});

export const PATCH = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const body = await readJson<Record<string, any>>(req);
  if (!body.id) return fail(400, "id is required");
  const existing = one<any>("SELECT * FROM ai_providers WHERE id = ?", body.id);
  if (!existing) return fail(404, "provider not found");
  if (body.isDefault) run("UPDATE ai_providers SET is_default = 0");
  run(
    `UPDATE ai_providers SET name = ?, kind = ?, base_url = ?, model = ?, api_key_enc = COALESCE(?, api_key_enc),
       temperature = ?, max_tokens = ?, timeout_ms = ?, enabled = ?, is_default = ? WHERE id = ?`,
    body.name ?? existing.name,
    body.kind ?? existing.kind,
    body.baseUrl ?? existing.base_url,
    body.model ?? existing.model,
    body.apiKey ? encryptSecret(body.apiKey) : null,
    Number(body.temperature ?? existing.temperature),
    Number(body.maxTokens ?? existing.max_tokens),
    Number(body.timeoutMs ?? existing.timeout_ms),
    body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
    body.isDefault === undefined ? existing.is_default : body.isDefault ? 1 : 0,
    body.id,
  );
  audit({ userId: user.id, action: "ai.updated", entity: "ai_provider", entityId: body.id });
  return ok({ updated: true });
});

export const DELETE = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail(400, "id is required");
  run("DELETE FROM ai_providers WHERE id = ?", id);
  audit({ userId: user.id, action: "ai.deleted", entity: "ai_provider", entityId: id });
  return ok({ deleted: id });
});

/** Ad-hoc generation used by the composer helper and the insight panel. */
export const PUT = route(async (req: Request) => {
  await requireRole();
  const body = await readJson<{
    mode?: "draft" | "variants" | "hashtags" | "translate" | "ask" | "improve";
    prompt?: string;
    platform?: string;
    tone?: string;
    language?: string;
    current?: string;
    providerId?: string;
  }>(req);

  const providerId = body.providerId ?? null;
  const mode = body.mode ?? "draft";

  if (mode === "ask") {
    if (!body.prompt) return fail(400, "prompt is required");
    const res = await answerFromMetrics(body.prompt, providerId);
    return ok({ text: res.text, model: res.model });
  }

  const systemByMode: Record<string, string> = {
    draft:
      "You write social media copy for a company account. Output only the post text, no emojis, no hashtags unless requested, no preamble, at most 3 short sentences.",
    variants:
      "You write social media copy variants. Output exactly three variants, each on its own line prefixed with 1., 2., 3. No emojis, no preamble.",
    hashtags:
      "You output a single line of 8 relevant hashtags, space separated, lowercase, no duplicates, no explanation.",
    translate: "You translate the given text faithfully into the requested language. Output only the translation.",
    improve: "You rewrite the given post so it is clearer and tighter while keeping the facts. Output only the rewritten text.",
  };
  if (!systemByMode[mode]) return fail(400, `unsupported mode ${mode}`);

  const userPrompt = [
    body.platform ? `platform: ${body.platform}` : "",
    body.tone ? `tone: ${body.tone}` : "",
    body.language ? `target language: ${body.language}` : "",
    body.current ? `current text:\n${body.current}` : "",
    body.prompt ? `instruction: ${body.prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await complete(
      [
        { role: "system", content: systemByMode[mode] },
        { role: "user", content: userPrompt || "Write about our new store opening hours." },
      ],
      { providerId, temperature: mode === "hashtags" ? 0.3 : 0.7, maxTokens: 700 },
    );
    return ok({ text: res.text, model: res.model, provider: res.providerName, latencyMs: res.latencyMs });
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : "generation failed");
  }
});
