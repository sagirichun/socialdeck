import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { all, one, run, uid, json, audit } from "./db";
import { env } from "./env";
import { sha256 } from "./crypto";
import { probe } from "./ffmpeg";

export interface MediaRow {
  id: string;
  filename: string;
  mime: string;
  kind: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  rel_path: string;
  sha256: string | null;
  created_at: string;
}

/** Derived once at insert: the console filters on kind, nothing needs to re-parse the mime type. */
const kindOf = (mime: string) => (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file");

export const absPath = (rel: string) => path.join(env.mediaDir, rel);

export function mediaById(id: string): MediaRow | null {
  return one<MediaRow>("SELECT * FROM media WHERE id = ?", id);
}

export function mediaList(limit = 200): MediaRow[] {
  return all<MediaRow>("SELECT * FROM media ORDER BY created_at DESC LIMIT ?", limit);
}

/** Absolute URL the platform fetches the asset from. Must be reachable by the network. */
export function publicUrl(mediaId: string): string {
  const base = (process.env.PUBLIC_MEDIA_BASE || env.appUrl).replace(/\/+$/, "");
  return `${base}/api/media/${mediaId}/raw`;
}

const ALLOWED = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
]);

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);

export async function saveUpload(file: File, userId: string | null): Promise<MediaRow> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`file exceeds ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit`);
  const ext = ALLOWED.get(file.type);
  if (!ext) throw new Error(`unsupported media type: ${file.type || "unknown"}`);

  const id = uid("med");
  const safeName = file.name.replace(/[^\w.\- ]+/g, "_").slice(-80) || `upload${ext}`;
  const rel = path.join("uploads", `${id}${ext}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  fs.mkdirSync(path.dirname(absPath(rel)), { recursive: true });
  fs.writeFileSync(absPath(rel), bytes);

  const meta = file.type.startsWith("video/") ? await probe(absPath(rel)) : {};

  run(
    `INSERT INTO media (id, filename, mime, kind, bytes, width, height, duration_s, rel_path, sha256, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    safeName,
    file.type,
    kindOf(file.type),
    bytes.length,
    meta.width ?? null,
    meta.height ?? null,
    meta.durationS ?? null,
    rel,
    sha256(bytes),
    userId,
  );
  audit({ userId, action: "media.upload", entity: "media", entityId: id, detail: { filename: safeName, bytes: bytes.length } });
  return mediaById(id)!;
}

/* --------------------------------------------------------------------------
 * Smart add-on: automatic aspect-ratio variants for cross-posting
 * (a 16:9 master becomes a 1:1 feed cut and a 9:16 short cut).
 * ------------------------------------------------------------------------ */

export const ASPECT_PRESETS = {
  "1:1": { w: 1080, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
} as const;

export type AspectKey = keyof typeof ASPECT_PRESETS;

/** Crop-to-fill the source into the target aspect ratio, centred, with a 2s fade-in. */
export function cropFilter(source: { w: number; h: number }, target: { w: number; h: number }) {
  const srcRatio = source.w / source.h;
  const dstRatio = target.w / target.h;
  const scale = srcRatio > dstRatio ? `-2:${target.h}` : `${target.w}:-2`;
  const crop = srcRatio > dstRatio ? `crop=${target.w}:${target.h}` : `crop=${target.w}:${target.h}`;
  return `scale=${scale},${crop},fps=30`;
}

export async function createVariant(
  mediaId: string,
  aspect: AspectKey,
  userId: string | null = null,
): Promise<MediaRow> {
  const src = mediaById(mediaId);
  if (!src) throw new Error("media not found");
  if (!src.mime.startsWith("video/")) throw new Error("variants are only generated for video assets");
  const target = ASPECT_PRESETS[aspect];
  const outRel = path.join("uploads", `${uid("med")}-${aspect.replace(":", "x")}.mp4`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    absPath(src.rel_path),
    "-vf",
    cropFilter({ w: src.width ?? target.w, h: src.height ?? target.h }, target),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    absPath(outRel),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(env.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || `ffmpeg exit ${code}`))));
  });

  const size = fs.statSync(absPath(outRel)).size;
  const meta = await probe(absPath(outRel));
  const id = uid("med");
  run(
    `INSERT INTO media (id, filename, mime, kind, bytes, width, height, duration_s, rel_path, sha256, created_by)
     VALUES (?, ?, 'video/mp4', 'video', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    `${path.parse(src.filename).name}-${aspect.replace(":", "x")}.mp4`,
    size,
    meta.width ?? target.w,
    meta.height ?? target.h,
    meta.durationS ?? src.duration_s,
    outRel,
    null,
    userId,
  );
  audit({ userId, action: "media.variant", entity: "media", entityId: id, detail: { source: mediaId, aspect } });
  return mediaById(id)!;
}

export function deleteMedia(id: string) {
  const row = mediaById(id);
  if (!row) return;
  try {
    fs.rmSync(absPath(row.rel_path), { force: true });
  } catch {
    /* file already gone */
  }
  run("DELETE FROM media WHERE id = ?", id);
  audit({ action: "media.delete", entity: "media", entityId: id });
}

export function mediaUsage(id: string) {
  return {
    posts: all<{ id: string; status: string }>("SELECT id, status FROM posts WHERE media_json LIKE ?", `%${id}%`),
    streams: all<{ id: string; name: string }>("SELECT id, name FROM streams WHERE playlist_json LIKE ?", `%${id}%`),
  };
}

export function parseMediaJson(raw: unknown): { mediaId: string; alt?: string }[] {
  return json<{ mediaId: string; alt?: string }[]>(raw, []);
}

/** Build the resolved media list for a publish job. */
export function resolveMedia(ids: string[]) {
  return ids
    .map((id) => mediaById(id))
    .filter((m): m is MediaRow => Boolean(m))
    .map((m) => ({
      mediaId: m.id,
      filename: m.filename,
      mime: m.mime,
      absPath: absPath(m.rel_path),
      publicUrl: publicUrl(m.id),
      bytes: m.bytes,
      durationS: m.duration_s,
    }));
}

export function sha256File(p: string) {
  return sha256(fs.readFileSync(p));
}
