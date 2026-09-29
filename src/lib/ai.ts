import { all, one, run, uid, json } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { env } from "./env";

export type AiProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "ollama"
  | "lmstudio"
  | "router"
  | "custom";

export interface ProviderRow {
  id: string;
  name: string;
  kind: AiProviderKind;
  base_url: string;
  model: string;
  api_key_enc: string | null;
  extra_json: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  enabled: number;
  is_default: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  providerId: string;
  providerName: string;
  latencyMs: number;
  raw?: unknown;
}

export function listProviders(onlyEnabled = false): ProviderRow[] {
  return all<ProviderRow>(
    `SELECT * FROM ai_providers ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY is_default DESC, name ASC`,
  );
}

export function defaultProvider(): ProviderRow | null {
  return (
    one<ProviderRow>("SELECT * FROM ai_providers WHERE enabled = 1 AND is_default = 1 ORDER BY name LIMIT 1") ??
    one<ProviderRow>("SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY name LIMIT 1")
  );
}

function joinUrl(base: string, suffix: string) {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/** Normalise the endpoint so both "http://host:11434" and "http://host:11434/v1" work. */
function chatEndpoint(p: ProviderRow): { url: string; mode: "openai" | "anthropic" | "ollama" } {
  const base = p.base_url.trim();
  switch (p.kind) {
    case "anthropic":
      return { url: joinUrl(base, base.includes("/v1") ? "messages" : "v1/messages"), mode: "anthropic" };
    case "ollama":
      return { url: joinUrl(base, "api/chat"), mode: "ollama" };
    default: {
      const url = base.endsWith("/v1")
        ? joinUrl(base, "chat/completions")
        : joinUrl(base, "v1/chat/completions");
      return { url, mode: "openai" };
    }
  }
}

/**
 * One completion call that speaks to external APIs (OpenAI, Anthropic) and to local
 * servers/routers (Ollama, LM Studio, any OpenAI-compatible gateway) with the same signature.
 */
export async function complete(
  messages: ChatMessage[],
  opts: { providerId?: string | null; temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  const provider = opts.providerId
    ? (one<ProviderRow>("SELECT * FROM ai_providers WHERE id = ? AND enabled = 1", opts.providerId) ??
      defaultProvider())
    : defaultProvider();

  if (!provider) throw new Error("No AI provider configured. Add one under AI Providers.");

  const key = decryptSecret(provider.api_key_enc) ?? process.env.OPENAI_API_KEY ?? "";
  const { url, mode } = chatEndpoint(provider);
  const extra = json<Record<string, string>>(provider.extra_json, {});
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  let body: Record<string, unknown>;

  if (mode === "anthropic") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    body = {
      model: provider.model,
      max_tokens: opts.maxTokens ?? provider.max_tokens,
      temperature: opts.temperature ?? provider.temperature,
      system: system || undefined,
      messages: messages.filter((m) => m.role !== "system"),
    };
  } else if (mode === "ollama") {
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model: provider.model,
      stream: false,
      options: { temperature: opts.temperature ?? provider.temperature, num_predict: opts.maxTokens ?? provider.max_tokens },
      messages,
    };
  } else {
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model: provider.model,
      messages,
      temperature: opts.temperature ?? provider.temperature,
      max_tokens: opts.maxTokens ?? provider.max_tokens,
      stream: false,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeout_ms || 60000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal ?? controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    let payload: any;
    try {
      payload = JSON.parse(text.split("data: [DONE]")[0].trim());
    } catch {
      // streaming-style payloads: take the last JSON object
      const line = text
        .split("\n")
        .map((l) => l.replace(/^data:\s*/, "").trim())
        .filter((l) => l.startsWith("{"))
        .pop();
      payload = line ? JSON.parse(line) : {};
    }
    const out =
      payload?.choices?.[0]?.message?.content ??
      payload?.content?.[0]?.text ??
      payload?.message?.content ??
      (typeof payload?.response === "string" ? payload.response : "") ??
      "";
    const usageModel = payload?.model ?? provider.model;
    run(
      "UPDATE ai_providers SET last_ok_at = datetime('now'), last_error = NULL WHERE id = ?",
      provider.id,
    );
    return {
      text: String(out).trim(),
      model: typeof usageModel === "string" ? usageModel : provider.model,
      providerId: provider.id,
      providerName: provider.name,
      latencyMs: Date.now() - started,
      raw: payload,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run("UPDATE ai_providers SET last_error = ? WHERE id = ?", msg.slice(0, 400), provider.id);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function testProvider(id: string) {
  const started = Date.now();
  try {
    const res = await complete([{ role: "user", content: "Reply with the single word: ready" }], {
      providerId: id,
      maxTokens: 16,
    });
    return { ok: true, latencyMs: Date.now() - started, model: res.model, sample: res.text.slice(0, 120) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------------------------------------------------------------------
 * Prompt builders for the reporting/agent read tools that the chat surfaces call.
 * ------------------------------------------------------------------------- */

export interface MetricSnapshot {
  accounts: number;
  connected: number;
  scheduled: number;
  published7d: number;
  failed: number;
  comments24h: number;
  pendingReplies: number;
  sentiment: number | null;
  liveStreams: number;
  topAccounts: { handle: string | null; platform: string; followers: number; engagement: number }[];
  riskCounts: { risk: string; count: number }[];
}

export function metricsSnapshot(): MetricSnapshot {
  const g = <T,>(sql: string, ...p: unknown[]) => one<T>(sql, ...p);
  const accounts = g<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!.n;
  const connected = g<{ n: number }>("SELECT COUNT(*) AS n FROM accounts WHERE status = 'connected'")!.n;
  const scheduled = g<{ n: number }>(
    "SELECT COUNT(*) AS n FROM posts WHERE status IN ('scheduled','queued')",
  )!.n;
  const published7d = g<{ n: number }>(
    "SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND updated_at >= datetime('now','-7 day')",
  )!.n;
  const failed = g<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE status = 'failed'")!.n;
  const comments24h = g<{ n: number }>(
    "SELECT COUNT(*) AS n FROM comments WHERE received_at >= datetime('now','-1 day')",
  )!.n;
  const pendingReplies = g<{ n: number }>(
    "SELECT COUNT(*) AS n FROM replies WHERE status = 'pending'",
  )!.n;
  const sentiment = one<{ v: number | null }>(
    "SELECT AVG(sentiment) AS v FROM comments WHERE received_at >= datetime('now','-7 day') AND sentiment IS NOT NULL",
  )?.v;
  const liveStreams = g<{ n: number }>("SELECT COUNT(*) AS n FROM streams WHERE state = 'live'")!.n;
  const topAccounts = all<{ handle: string | null; platform: string; followers: number; engagement: number }>(
    `SELECT a.handle, a.platform, COALESCE(MAX(ad.followers),0) AS followers, COALESCE(SUM(ad.engagements),0) AS engagement
     FROM accounts a LEFT JOIN analytics_daily ad ON ad.account_id = a.id
     GROUP BY a.id ORDER BY engagement DESC, followers DESC LIMIT 5`,
  );
  const riskCounts = all<{ risk: string; count: number }>(
    `SELECT risk, COUNT(*) AS count FROM comments WHERE received_at >= datetime('now','-7 day')
     GROUP BY risk ORDER BY count DESC`,
  );
  return {
    accounts,
    connected,
    scheduled,
    published7d,
    failed,
    comments24h,
    pendingReplies,
    sentiment: sentiment ?? null,
    liveStreams,
    topAccounts,
    riskCounts,
  };
}

const SYSTEM = `You are the operations analyst embedded in SocialDeck, an enterprise social media operations platform.
Answer only from the JSON snapshot you are given. Numbers must be exact; never invent metrics, platform names or timelines.
Reply in the same language the operator used (Indonesian or English). Be concise, use short labelled lines or bullets,
never emojis, no preamble, no markdown tables. When a number is zero, say it is zero.`;

export async function answerFromMetrics(question: string, providerId?: string | null) {
  const snapshot = metricsSnapshot();
  const pending = all<{ platform: string; author_handle: string | null; body: string; risk: string; sentiment: number | null }>(
    "SELECT platform, author_handle, body, risk, sentiment FROM comments WHERE received_at >= datetime('now','-3 day') ORDER BY received_at DESC LIMIT 25",
  );
  const upcoming = all<{ platform: string; handle: string | null; scheduled_at: string | null; kind: string; status: string }>(
    `SELECT a.platform, a.handle, p.scheduled_at, p.kind, p.status FROM posts p
     JOIN accounts a ON a.id = p.account_id WHERE p.status IN ('scheduled','queued','draft') ORDER BY p.scheduled_at LIMIT 15`,
  );
  const user = `OPERATOR QUESTION
${question}

METRICS SNAPSHOT
${JSON.stringify(snapshot)}

RECENT INBOUND (latest 25, newest first)
${JSON.stringify(pending)}

QUEUE AHEAD
${JSON.stringify(upcoming)}`;

  return complete(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { providerId, temperature: 0.2, maxTokens: 900 },
  );
}

const REPLY_SYSTEM = `You write public replies on behalf of a brand's social media team.
Rules:
- Answer in the language of the incoming message.
- Maximum 2 short sentences, no emojis, no hashtags, no links unless the inbound explicitly requests a link.
- Never promise refunds, compensation, legal outcomes or timelines that are not in the brand guidance.
- If the message is a complaint, acknowledge the specific issue and route it to the support channel given in the brand guidance.
- If the message mentions legal action, regulators, health authorities or press, output exactly: ESCALATE
- If the message is spam or an obvious bot, output exactly: SPAM
Output only the reply text.`;

export interface ReplyContext {
  accountHandle: string | null;
  platform: string;
  brandGuidance: string;
  tone: string;
  language: string;
  inboundAuthor: string | null;
  inboundBody: string;
  history: { inbound: string; outbound: string }[];
  providerId?: string | null;
}

export async function draftReply(ctx: ReplyContext) {
  const exemplars = ctx.history.length
    ? `APPROVED REPLIES FROM THIS SAME ACCOUNT (style reference)
${ctx.history.map((h) => `in: ${h.inbound}\nout: ${h.outbound}`).join("\n")}`
    : "APPROVED REPLIES FROM THIS ACCOUNT\nnone yet";

  const user = `BRAND
account: ${ctx.accountHandle ?? "unknown"} on ${ctx.platform}
tone: ${ctx.tone}
preferred language: ${ctx.language}
brand guidance: ${ctx.brandGuidance || "no additional guidance"}

${exemplars}

INCOMING MESSAGE
from: ${ctx.inboundAuthor ?? "unknown"}
text: ${ctx.inboundBody}`;

  const res = await complete(
    [
      { role: "system", content: REPLY_SYSTEM },
      { role: "user", content: user },
    ],
    { providerId: ctx.providerId, temperature: 0.5, maxTokens: 300 },
  );
  return res;
}

const SENTIMENT_SYSTEM = `Classify one social media message. Return strict JSON, no prose:
{"sentiment": <float -1..1>, "intent": "question"|"praise"|"complaint"|"spam"|"other", "language": "<iso-639-1>", "risk": "none"|"sensitive"|"crisis"|"spam"}`;

export async function classifyMessage(body: string, providerId?: string | null) {
  const res = await complete(
    [
      { role: "system", content: SENTIMENT_SYSTEM },
      { role: "user", content: body.slice(0, 2000) },
    ],
    { providerId, temperature: 0, maxTokens: 120 },
  );
  const match = res.text.match(/\{[\s\S]*\}/);
  const parsed = match ? json<Record<string, unknown>>(match[0], {}) : {};
  const sentiment = Number(parsed.sentiment);
  return {
    sentiment: Number.isFinite(sentiment) ? Math.max(-1, Math.min(1, sentiment)) : null,
    intent: typeof parsed.intent === "string" ? parsed.intent : null,
    language: typeof parsed.language === "string" ? parsed.language : null,
    risk: typeof parsed.risk === "string" ? parsed.risk : "none",
    providerId: res.providerId,
    model: res.model,
  };
}

export { encryptSecret, decryptSecret };
export const outboundMode = env.outboundMode;
