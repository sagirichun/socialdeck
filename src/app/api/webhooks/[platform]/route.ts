import { requireRole } from "@/lib/auth";
import { ok, fail, route } from "@/lib/api";
import { receiveWebhook, verifySignature, normalise, webhookLog } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = new Set(["facebook", "instagram", "threads", "x", "tiktok", "youtube", "generic"]);

/** Webhook ledger view for the console. */
export const GET = route(async () => {
  await requireRole();
  return ok({
    events: webhookLog(60),
    endpoints: [...PLATFORMS].map((p) => ({
      platform: p,
      url: `/api/webhooks/${p}`,
      secretEnv: `WEBHOOK_SECRET_${p.toUpperCase()}`,
      signed: Boolean(process.env[`WEBHOOK_SECRET_${p.toUpperCase()}`] || process.env.WEBHOOK_SECRET),
    })),
  });
});

/**
 * Ingestion endpoint. Accepts the platform's native payload, verifies the signature when a
 * secret is configured, stores the raw body, then processes asynchronously.
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ platform: string }> }) => {
  const { platform } = await ctx.params;
  if (!PLATFORMS.has(platform)) return fail(404, `no webhook endpoint for ${platform}`);
  const raw = await req.text();

  // Meta verification handshake (GET is handled by the sibling route, this guards POST only).
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return fail(400, "body must be JSON");
  }

  const signatureOk = verifySignature(platform, raw, req.headers);
  const res = await receiveWebhook(platform, raw, payload, { signatureOk, topic: null });
  if (!signatureOk) return fail(401, "signature verification failed");

  // Meta expects a fast 200 with no body.
  return new Response("EVENT_RECEIVED", { status: 200 });
});
