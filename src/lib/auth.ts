import { cookies } from "next/headers";
import crypto from "node:crypto";
import { one, run, uid, audit } from "./db";
import { hashPassword, verifyPassword, newToken, tokenHash } from "./crypto";
import { env } from "./env";

export const SESSION_COOKIE = "sd_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null }) {
  const token = newToken();
  const expires = new Date(Date.now() + env.sessionTtlHours * 3600_000);
  run(
    "INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    uid("ses"),
    userId,
    tokenHash(token),
    meta.userAgent?.slice(0, 300) ?? null,
    meta.ip ?? null,
    expires.toISOString(),
  );
  return { token, expires };
}

export function destroySession(token: string) {
  run("DELETE FROM sessions WHERE token_hash = ?", tokenHash(token));
}

/** Resolve the caller from the cookie. Returns null for anonymous requests. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = one<SessionUser & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    tokenHash(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "authentication required");
  return user;
}

export function requireRole(...roles: string[]): Promise<SessionUser> {
  return requireUser().then((user) => {
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, `requires role: ${roles.join(" or ")}`);
    return user;
  });
}

export function authenticate(email: string, password: string): SessionUser | null {
  const row = one<{ id: string; email: string; name: string; role: string; password_hash: string }>(
    "SELECT id, email, name, role, password_hash FROM users WHERE email = ?",
    email.trim().toLowerCase(),
  );
  if (!row) {
    // Constant-ish work on the miss path so timing does not disclose account existence.
    verifyPassword(password, hashPassword("placeholder"));
    return null;
  }
  if (!verifyPassword(password, row.password_hash)) {
    audit({ action: "auth.failed", entity: "user", entityId: row.id, detail: { email } });
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/**
 * First-run bootstrap. With no SEED_ADMIN_PASSWORD set, a random password is generated and
 * returned once — a published default would hand owner access to anyone reading this repo.
 */
export function bootstrapAdminIfEmpty() {
  const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
  if (count > 0) return null;
  const email = process.env.SEED_ADMIN_EMAIL || "admin@socialdeck.local";
  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(15).toString("base64url");
  run(
    "INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, 'Operations Lead', ?, 'owner')",
    uid("usr"),
    email,
    hashPassword(password),
  );
  return { email, password };
}

export const ROLES = ["owner", "admin", "operator", "analyst"] as const;
