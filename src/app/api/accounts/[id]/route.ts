import { one, run, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { syncComments } from "@/lib/replies";
import { getAdapter, loadAccount, ensureFreshToken, TokenRefreshRequired } from "@/lib/platforms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole();
  const { id } = await ctx.params;
  const row = one<any>("SELECT * FROM accounts WHERE id = ?", id);
  if (!row) return fail(404, "account not found");
  const meta = json<Record<string, unknown>>(row.meta_json, {});
  return ok({
    ...row,
    // Token material never leaves the process; only a masked fingerprint goes back.
    access_token_enc: undefined,
    refresh_token_enc: undefined,
    access_token_masked: maskSecret(decryptSecret(row.access_token_enc)),
    has_refresh: Boolean(row.refresh_token_enc),
    auto_publish: meta.autoPublish === false ? 0 : 1,
    meta,
  });
});

export const PATCH = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const body = await readJson<{
    handle?: string;
    displayName?: string;
    status?: string;
    autoPublish?: boolean;
    accessToken?: string;
    refreshToken?: string;
    sync?: boolean;
  }>(req);

  const row = one<any>("SELECT id, meta_json FROM accounts WHERE id = ?", id);
  if (!row) return fail(404, "account not found");

  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.handle !== undefined) (fields.push("handle = ?"), values.push(body.handle));
  if (body.displayName !== undefined) (fields.push("display_name = ?"), values.push(body.displayName));
  if (body.status !== undefined) (fields.push("status = ?"), values.push(body.status));
  if (body.accessToken) (fields.push("access_token_enc = ?"), values.push(encryptSecret(body.accessToken)));
  if (body.refreshToken) (fields.push("refresh_token_enc = ?"), values.push(encryptSecret(body.refreshToken)));
  if (body.autoPublish !== undefined) {
    const merged = { ...json<Record<string, unknown>>(row.meta_json, {}), autoPublish: body.autoPublish };
    (fields.push("meta_json = ?"), values.push(JSON.stringify(merged)));
  }
  if (fields.length) {
    fields.push("updated_at = datetime('now')");
    run(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`, ...values, id);
    audit({ userId: user.id, action: "account.updated", entity: "account", entityId: id, detail: { fields: fields.map((f) => f.split(" ")[0]) } });
  }

  if (body.sync) {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const res = await syncComments(id, since);
    return ok({ updated: fields.length > 0, sync: res });
  }
  return ok({ updated: fields.length > 0 });
});

/** POST is the imperative surface: verify credentials or sync now, addressed by id. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const body = await readJson<{ action?: "verify" | "sync"; sinceHours?: number }>(req);

  const account = loadAccount(id);
  if (!account) return fail(404, "account not found");
  const adapter = getAdapter(account.platform);

  if (body.action === "sync") {
    const since = new Date(Date.now() - (body.sinceHours ?? 24) * 3600_000).toISOString();
    return ok(await syncComments(id, since));
  }

  if (body.action === "verify") {
    try {
      account.accessToken = ensureFreshToken(account).accessToken;
      if (!adapter.fetchMetrics) {
        // Platforms without a metrics endpoint still prove the token by returning the profile.
        return ok({ ok: true, identity: { externalId: account.externalId, handle: account.handle }, simulated: false });
      }
      const metrics = await adapter.fetchMetrics(account);
      run("UPDATE accounts SET status = 'connected', last_error = NULL, updated_at = datetime('now') WHERE id = ?", id);
      audit({ userId: user.id, action: "account.verified", entity: "account", entityId: id });
      return ok({ ok: true, identity: metrics, simulated: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run("UPDATE accounts SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?", err instanceof TokenRefreshRequired ? "expired" : "error", message.slice(0, 500), id);
      return ok({ ok: false, error: message });
    }
  }
  return fail(400, "unknown action");
});

export const DELETE = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin");
  const { id } = await ctx.params;
  run("DELETE FROM accounts WHERE id = ?", id);
  audit({ userId: user.id, action: "account.disconnected", entity: "account", entityId: id });
  return ok({ deleted: id });
});
