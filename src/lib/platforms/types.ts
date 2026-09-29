import { request, formEncode } from "./rest";
import { uid, all, one, run } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";

export type PlatformKey =
  | "facebook"
  | "instagram"
  | "tiktok"
  | "youtube"
  | "x"
  | "threads"
  | "linkedin"
  | "pinterest"
  | "mastodon"
  // Stream targets are addressable "accounts" but are driven by the relay supervisor,
  // never by the publish queue.
  | "rtmp";

export type MediaKind = "text" | "image" | "video";

export interface MediaRef {
  mediaId: string;
  filename: string;
  mime: string;
  absPath: string;
  publicUrl?: string;
  bytes: number;
  durationS?: number | null;
}

export interface AccountRef {
  id: string;
  platform: PlatformKey;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  meta: Record<string, any>;
}

export interface PublishInput {
  account: AccountRef;
  kind: MediaKind | "short" | "story" | "reel";
  body: string;
  title?: string | null;
  linkUrl?: string | null;
  media: MediaRef[];
  scheduledAt?: string | null;
}

export interface PublishResult {
  externalId: string;
  permalink?: string;
  raw?: unknown;
}

export interface InboundComment {
  externalId: string;
  parentExternalId?: string | null;
  threadKind?: "comment" | "mention" | "dm" | "review";
  postExternalId?: string | null;
  authorHandle?: string | null;
  authorName?: string | null;
  body: string;
  receivedAt?: string;
}

export interface MetricSet {
  day: string;
  followers?: number;
  impressions?: number;
  engagements?: number;
}

export interface Capabilities {
  oauth: "oauth2" | "manual";
  nativeScheduling: boolean;
  kinds: MediaKind[];
  comments: boolean;
  metrics: boolean;
  rtmp: boolean;
  maxBodyLen: number;
}

export interface OAuthDescriptor {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce: boolean;
  /** Extra params some providers require on the authorize step. */
  authorizeParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  scopes?: string;
  externalId: string;
  handle?: string | null;
  displayName?: string | null;
  accountType?: string;
  meta?: Record<string, any>;
}

export interface PlatformAdapter {
  key: PlatformKey;
  label: string;
  glyph: string;
  docsUrl: string;
  capabilities: Capabilities;
  oauth?: OAuthDescriptor;
  /** Manual-credential platforms (RTMP style) instead of OAuth. */
  credentialFields?: { name: string; label: string; secret: boolean }[];
  exchangeCode?(params: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
    codeVerifier?: string;
  }): Promise<TokenSet>;
  refresh?(account: AccountRef, clientId: string, clientSecret: string): Promise<TokenSet>;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchComments?(account: AccountRef, sinceIso: string): Promise<InboundComment[]>;
  fetchMetrics?(account: AccountRef): Promise<MetricSet>;
  /** Send a reply to an existing inbound item. Defaults to a comment endpoint when omitted. */
  reply?(account: AccountRef, commentExternalId: string, body: string): Promise<{ externalId: string }>;
}

/* -------------------------------------------------------------------------- */
/* helpers shared by the adapters                                             */
/* -------------------------------------------------------------------------- */

export function loadAccount(id: string): AccountRef | null {
  const row = one<any>("SELECT * FROM accounts WHERE id = ?", id);
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.external_id,
    handle: row.handle,
    displayName: row.display_name,
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
    meta: row.meta_json ? JSON.parse(row.meta_json) : {},
  };
}

export function persistTokens(accountId: string, tokens: TokenSet) {
  run(
    `UPDATE accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
      token_expires_at = ?, scopes = COALESCE(?, scopes), status = 'connected', last_error = NULL,
      handle = COALESCE(?, handle), display_name = COALESCE(?, display_name),
      meta_json = ?, updated_at = datetime('now') WHERE id = ?`,
    encryptSecret(tokens.accessToken),
    encryptSecret(tokens.refreshToken ?? null),
    tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
    tokens.scopes ?? null,
    tokens.handle ?? null,
    tokens.displayName ?? null,
    JSON.stringify(tokens.meta ?? {}),
    accountId,
  );
}

export function ensureFreshToken(account: AccountRef): AccountRef {
  const row = one<any>("SELECT token_expires_at FROM accounts WHERE id = ?", account.id);
  if (!row?.token_expires_at) return account;
  const expires = new Date(row.token_expires_at).getTime();
  // Refresh 10 minutes before expiry.
  if (Number.isFinite(expires) && expires - 600_000 > Date.now()) return account;
  const adapter = getAdapter(account.platform);
  const app = appCredentials(account.platform);
  if (!adapter.refresh || !account.refreshToken || !app) {
    run("UPDATE accounts SET status = 'expired' WHERE id = ?", account.id);
    return account;
  }
  throw new TokenRefreshRequired(account.id);
}

export class TokenRefreshRequired extends Error {
  constructor(readonly accountId: string) {
    super(`token refresh required for account ${accountId}`);
  }
}

export async function refreshAccountToken(accountId: string) {
  const account = loadAccount(accountId);
  if (!account) throw new Error("account not found");
  const adapter = getAdapter(account.platform);
  const app = appCredentials(account.platform);
  if (!adapter.refresh || !account.refreshToken || !app) return account;
  const tokens = await adapter.refresh(account, app.client_id, decryptSecret(app.client_secret_enc) ?? "");
  persistTokens(accountId, tokens);
  return loadAccount(accountId)!;
}

export function appCredentials(platform: PlatformKey) {
  return one<{ client_id: string; client_secret_enc: string; redirect_uri: string; scopes: string; extra_json: string }>(
    "SELECT * FROM oauth_apps WHERE platform = ?",
    platform,
  );
}

// Imported lazily below to avoid a circular import at module load.
export function getAdapter(platform: PlatformKey): PlatformAdapter {
  const adapter = REGISTRY[platform];
  if (!adapter) throw new Error(`unsupported platform: ${platform}`);
  return adapter;
}

export const REGISTRY: Partial<Record<PlatformKey, PlatformAdapter>> = {};
export function registerAdapter(adapter: PlatformAdapter) {
  REGISTRY[adapter.key] = adapter;
}

export function listAdapters(): PlatformAdapter[] {
  return Object.values(REGISTRY) as PlatformAdapter[];
}

export function tokensFor(platform: PlatformKey) {
  const app = appCredentials(platform);
  if (!app) return null;
  return { clientId: app.client_id, clientSecret: decryptSecret(app.client_secret_enc) ?? "", app };
}

export { request, formEncode, uid, all, one, run };
