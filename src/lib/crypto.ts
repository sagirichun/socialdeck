import crypto from "node:crypto";
import { env } from "./env";

const KEY = crypto.createHash("sha256").update(env.secret).digest(); // 32 bytes for aes-256-gcm

/** Encrypt a secret (token, stream key, client secret) for at-rest storage. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Only the last 4 characters are ever shown in the UI. */
export function maskSecret(plain: string | null | undefined): string {
  if (!plain) return "";
  const tail = plain.slice(-4);
  return `••••••••${tail}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  const derived = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, derived);
}

export const sha256 = (v: string | Buffer) => crypto.createHash("sha256").update(v).digest("hex");
export const newToken = () => crypto.randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => sha256(`sd.session.${token}`);

/** Webhook signature checks (Meta: X-Hub-Signature-256, X/Twitter: base64 HMAC, generic). */
export function verifyHmacSha256(rawBody: string, header: string, secret: string, prefix = "sha256="): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const given = header.startsWith(prefix) ? header.slice(prefix.length) : header;
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export function verifyHmacBase64(rawBody: string, header: string, secret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
