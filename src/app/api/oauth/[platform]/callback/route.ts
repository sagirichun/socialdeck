import { NextResponse } from "next/server";
import { one, run, uid, audit, setting, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { route, fail } from "@/lib/api";
import { getAdapter, persistTokens } from "@/lib/platforms";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 2: validate state, exchange the code, upsert the account, then return to the console. */
export const GET = route(async (req: Request, ctx: { params: Promise<{ platform: string }> }) => {
  await requireRole("owner", "admin", "operator");
  const { platform } = await ctx.params;
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const finish = (query: Record<string, string>) =>
    NextResponse.redirect(`${env.appUrl}/accounts?${new URLSearchParams(query).toString()}`, { status: 303 });

  if (error) return finish({ connected: "0", platform, reason: error });
  if (!code) return finish({ connected: "0", platform, reason: "missing_code" });

  const stored = json<{ state?: string; at?: number; redirectUri?: string }>(setting(`oauth_state_${platform}`, ""), {});
  if (!stored.state || stored.state !== returnedState) return finish({ connected: "0", platform, reason: "state_mismatch" });
  if (stored.at && Date.now() - stored.at > 15 * 60_000) return finish({ connected: "0", platform, reason: "state_expired" });

  const app = one<{ client_id: string; client_secret_enc: string; redirect_uri: string }>(
    "SELECT client_id, client_secret_enc, redirect_uri FROM oauth_apps WHERE platform = ?",
    platform,
  );
  if (!app) return finish({ connected: "0", platform, reason: "app_not_configured" });

  const adapter = getAdapter(platform as never);
  if (!adapter.exchangeCode) return finish({ connected: "0", platform, reason: "exchange_unsupported" });

  const verifier = setting(`oauth_pkce_${platform}`, "");
  let tokens;
  try {
    tokens = await adapter.exchangeCode({
      code,
      redirectUri: stored.redirectUri || app.redirect_uri || `${env.appUrl}/api/oauth/${platform}/callback`,
      clientId: app.client_id,
      clientSecret: decryptSecret(app.client_secret_enc) ?? "",
      codeVerifier: verifier || undefined,
    });
  } catch (err) {
    audit({ actor: "platform", action: "oauth.exchange_failed", entity: "platform", entityId: platform, detail: { error: String(err) } });
    return finish({ connected: "0", platform, reason: "exchange_failed" });
  }

  const existing = one<{ id: string }>(
    "SELECT id FROM accounts WHERE platform = ? AND external_id = ?",
    platform,
    tokens.externalId,
  );
  const accountId = existing?.id ?? uid("acc");
  if (existing) {
    persistTokens(accountId, tokens);
  } else {
    run(
      `INSERT INTO accounts (id, platform, external_id, handle, display_name, account_type, access_token_enc, refresh_token_enc,
         token_expires_at, scopes, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', 'connected', '{}')`,
      accountId,
      platform,
      tokens.externalId,
      tokens.handle ?? null,
      tokens.displayName ?? null,
      tokens.accountType ?? "page",
    );
    persistTokens(accountId, tokens);
  }

  run("DELETE FROM settings WHERE key IN (?, ?)", `oauth_state_${platform}`, `oauth_pkce_${platform}`);
  audit({ action: "oauth.completed", entity: "account", entityId: accountId, detail: { platform, handle: tokens.handle } });
  return finish({ connected: "1", platform, account: accountId });
});
