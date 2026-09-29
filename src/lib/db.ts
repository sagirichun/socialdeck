import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "./env";

/**
 * SQLite via node:sqlite (built into Node >= 22). Zero external services required for a
 * single-node deployment; every query below is plain SQL so a Postgres move is a driver swap.
 */
declare global {
  // eslint-disable-next-line no-var
  var __socialdeckDb: DatabaseSync | undefined;
}

export const uid = (prefix = "") =>
  `${prefix}${prefix ? "_" : ""}${crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 12)}`;

function open(): DatabaseSync {
  // busy_timeout must precede journal_mode: with the SQLite default (0) a concurrent
  // opener fails with SQLITE_BUSY instead of waiting (observed during parallel builds).
  const db = new DatabaseSync(env.dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export const db: DatabaseSync =
  globalThis.__socialdeckDb ?? (globalThis.__socialdeckDb = open());

type Param = string | number | bigint | null | Uint8Array;

/** node:sqlite only accepts primitives; normalise undefined/boolean/objects here, once. */
function norm(p: unknown): Param {
  if (p === undefined || p === null) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  if (typeof p === "number" || typeof p === "bigint" || typeof p === "string") return p;
  if (p instanceof Uint8Array) return p;
  return JSON.stringify(p);
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params.map(norm)) as T[];
}

export function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null {
  return (db.prepare(sql).get(...params.map(norm)) as T | undefined) ?? null;
}

export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...params.map(norm));
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function migrate(dir = path.join(env.root, "src/db/migrations")): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set(all<{ name: string }>("SELECT name FROM _migrations").map((r) => r.name));
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    tx(() => {
      db.exec(sql);
      run("INSERT INTO _migrations (name) VALUES (?)", file);
    });
    done.push(file);
  }
  return done;
}

export function audit(entry: {
  actor?: string | null;
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string | null;
  detail?: unknown;
  ip?: string | null;
}) {
  run(
    `INSERT INTO audit_logs (id, user_id, actor, action, entity, entity_id, detail_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uid("aud"),
    entry.userId ?? null,
    entry.actor ?? entry.userId ?? "system",
    entry.action,
    entry.entity ?? null,
    entry.entityId ?? null,
    JSON.stringify(entry.detail ?? {}),
    entry.ip ?? null,
  );
}

export function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function setting(key: string, fallback = ""): string {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}
