import { all, one, run, uid, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { listAdapters } from "@/lib/platforms";
import { encryptSecret } from "@/lib/crypto";
import { queueHealth } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");

  const accounts = all<any>(
    `SELECT a.id, a.platform, a.external_id, a.handle, a.display_name, a.account_type, a.status,
            a.token_expires_at, a.scopes, a.last_error, a.created_at, a.updated_at, a.meta_json,
            (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'published') AS published_count,
            (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status IN ('scheduled','queued')) AS queued_count,
            (SELECT COUNT(*) FROM comments c WHERE c.account_id = a.id AND c.received_at >= datetime('now','-7 day')) AS inbound_7d
     FROM accounts a
     ${platform ? "WHERE a.platform = ?" : ""}
     ORDER BY a.platform, a.handle`,
    ...(platform ? [platform] : []),
  ).map((row) => {
    const meta = json<Record<string, unknown>>(row.meta_json ?? "{}", {});
    const { meta_json, ...rest } = row;
    return {
      ...rest,
      label: row.display_name ?? row.handle ?? row.external_id,
      followers: Number(meta.followers ?? 0),
      following: Number(meta.following ?? 0),
      // Absent meta means "allowed to publish": the account-level gate is opt-out, not opt-in.
      auto_publish: meta.autoPublish === false ? 0 : 1,
      meta,
    };
  });

  const catalog = listAdapters().map((a) => ({
    key: a.key,
    label: a.label,
    glyph: a.glyph,
    docsUrl: a.docsUrl,
    capabilities: a.capabilities,
    oauth: a.oauth ?? null,
    credentialFields: a.credentialFields ?? [],
    configured: Boolean(one("SELECT 1 AS n FROM oauth_apps WHERE platform = ?", a.key)),
  }));

  // Flattened view for the console: capability flags as a list, OAuth descriptor pre-shaped.
  const platforms = catalog.map((a) => ({
    key: a.key,
    label: a.label,
    capabilities: [
      a.capabilities.oauth === "oauth2" ? "oauth2" : "manual credentials",
      ...(a.capabilities.nativeScheduling ? ["native scheduling"] : []),
      `publish: ${a.capabilities.kinds.join(", ")}`,
      ...(a.capabilities.comments ? ["comments"] : []),
      ...(a.capabilities.metrics ? ["metrics"] : []),
      ...(a.capabilities.rtmp ? ["rtmp relay"] : []),
      `max ${a.capabilities.maxBodyLen} chars`,
    ],
    oauth: {
      authorizeUrl: a.oauth?.authorizeUrl ?? "",
      scopes: a.oauth?.scopes ?? [],
      usesPkce: Boolean(a.oauth?.pkce),
      requiresExternalId: true,
      docs: a.docsUrl,
    },
    configured: a.configured,
  }));

  return ok({ accounts, catalog, platforms, queue: queueHealth() });
});

/** Manual connection: used for RTMP targets, Mastodon instances, or tokens minted elsewhere. */
export const POST = route(async (req: Request) => {
  const user = await requireRole();
  const body = await readJson<{
    platform?: string;
    externalId?: string;
    handle?: string;
    displayName?: string;
    accountType?: string;
    accessToken?: string;
    refreshToken?: string;
    meta?: Record<string, unknown>;
  }>(req);

  if (!body.platform || !body.externalId) return fail(400, "platform and externalId are required");
  const adapter = listAdapters().find((a) => a.key === body.platform);
  if (!adapter) return fail(400, `unsupported platform: ${body.platform}`);

  const id = uid("acc");
  run(
    `INSERT INTO accounts (id, platform, external_id, handle, display_name, account_type,
       access_token_enc, refresh_token_enc, scopes, status, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'connected', ?)`,
    id,
    body.platform,
    body.externalId,
    body.handle ?? null,
    body.displayName ?? body.handle ?? null,
    body.accountType ?? "page",
    encryptSecret(body.accessToken ?? null),
    encryptSecret(body.refreshToken ?? null),
    JSON.stringify(body.meta ?? {}),
  );
  audit({ userId: user.id, action: "account.connected", entity: "account", entityId: id, detail: { platform: body.platform, manual: true } });
  return ok({ id }, { status: 201 });
});
