import path from "node:path";
import fs from "node:fs";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Reject any path that escapes the media root. Returns the absolute path or throws. */
export function safeJoin(root: string, rel: string): string {
  if (!rel || rel.includes("\0")) throw new Error("invalid path");
  const segments = rel.split(/[\\/]+/);
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") throw new Error("path traversal rejected");
    if (!SAFE_SEGMENT.test(seg)) throw new Error(`illegal path segment: ${seg}`);
  }
  const abs = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) throw new Error("path outside media root");
  return abs;
}

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Filesystem-safe file name that keeps the extension. */
export function safeFilename(name: string, fallbackExt = "") {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").trim();
  const cleaned = base.slice(-100) || `file${fallbackExt}`;
  return cleaned.startsWith(".") ? `file${cleaned}` : cleaned;
}
