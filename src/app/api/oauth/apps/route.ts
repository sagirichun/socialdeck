import { all, one, run, uid, audit } from "@/lib/db";
import { requireRole, HttpError } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { encryptSecret } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole();
  const apps = all<any>("SELECT platform, client_id, redirect_uri, scopes FROM oauth_apps ORDER BY platform").map((a) => ({
    platform: a.platform,
    client_id: a.client_id,
    redirect_uri: a.redirect_uri,
    scopes: a.scopes,
    has_secret: Boolean(one("SELECT 1 AS n FROM oauth_apps WHERE platform = ? AND client_secret_enc IS NOT NULL", a.platform)),
    configured: Boolean(a.client_id && a.redirect_uri),
  }));
  return ok({ apps });
});

/** Store the OAuth application credentials for one platform (client id/secret/redirect). */
export const POST = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const body = await readJson<{
    platform?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes?: string;
    extra?: Record<string, string>;
  }>(req);
  if (!body.platform || !body.clientId) return fail(400, "platform and clientId are required");

  const existing = one<{ id: string }>("SELECT id FROM oauth_apps WHERE platform = ?", body.platform);
  if (existing) {
    run(
      `UPDATE oauth_apps SET client_id = ?, client_secret_enc = COALESCE(?, client_secret_enc),
         redirect_uri = COALESCE(?, redirect_uri), scopes = COALESCE(?, scopes), extra_json = COALESCE(?, extra_json)
       WHERE id = ?`,
      body.clientId,
      body.clientSecret ? encryptSecret(body.clientSecret) : null,
      body.redirectUri ?? null,
      body.scopes ?? null,
      body.extra ? JSON.stringify(body.extra) : null,
      existing.id,
    );
    run("DELETE FROM settings WHERE key = ?", `oauth_pkce_${body.platform}`);
    audit({ userId: user.id, action: "oauth_app.updated", entity: "oauth_app", entityId: existing.id, detail: { platform: body.platform } });
    return ok({ id: existing.id, updated: true });
  }

  const id = uid("oap");
  run(
    `INSERT INTO oauth_apps (id, platform, client_id, client_secret_enc, redirect_uri, scopes, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.platform,
    body.clientId,
    encryptSecret(body.clientSecret ?? null),
    body.redirectUri ?? "",
    body.scopes ?? "",
    JSON.stringify(body.extra ?? {}),
  );
  audit({ userId: user.id, action: "oauth_app.created", entity: "oauth_app", entityId: id, detail: { platform: body.platform } });
  return ok({ id, created: true }, { status: 201 });
});

