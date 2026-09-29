import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { one, run, uid, audit, setSetting, setting } from "@/lib/db";
import { requireRole, HttpError } from "@/lib/auth";
import { route, fail } from "@/lib/api";
import { getAdapter } from "@/lib/platforms";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Step 1 of the OAuth handshake: build the provider URL, persist the state (and PKCE verifier
 * where the provider requires it), then hand the browser to the platform.
 */
export const GET = route(async (req: Request, ctx: { params: Promise<{ platform: string }> }) => {
  const user = await requireRole("owner", "admin", "operator");
  const { platform } = await ctx.params;
  const adapter = getAdapter(platform as never);
  if (!adapter?.oauth) return fail(400, `${platform} does not support a redirect-based connection`);

  const app = one<{ client_id: string; redirect_uri: string; scopes: string }>(
    "SELECT client_id, redirect_uri, scopes FROM oauth_apps WHERE platform = ?",
    platform,
  );
  if (!app) return fail(400, `no OAuth application configured for ${platform}. Add the client id and secret first.`);

  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = app.redirect_uri || `${env.appUrl}/api/oauth/${platform}/callback`;
  let verifier: string | undefined;

  if (adapter.oauth.pkce) {
    verifier = crypto.randomBytes(48).toString("base64url");
    setSetting(`oauth_pkce_${platform}`, verifier);
  }
  setSetting(`oauth_state_${platform}`, JSON.stringify({ state, userId: user.id, at: Date.now(), redirectUri }));

  const url = new URL(adapter.oauth.authorizeUrl);
  if (platform === "tiktok") {
    url.searchParams.set("client_key", app.client_id);
  } else {
    url.searchParams.set("client_id", app.client_id);
  }
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", platform === "tiktok" ? "code" : "code");
  url.searchParams.set("scope", app.scopes || adapter.oauth.scopes.join(platform === "tiktok" ? "," : " "));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(adapter.oauth.authorizeParams ?? {})) url.searchParams.set(k, v);
  if (verifier) {
    url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }

  audit({ userId: user.id, action: "oauth.start", entity: "platform", entityId: platform });
  return NextResponse.redirect(url.toString());
});
