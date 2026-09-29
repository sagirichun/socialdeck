import fs from "node:fs";
import { all, one, run, uid, json, audit } from "./db";
import { env } from "./env";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto";
import {
  startLoopStream,
  writePlaylist,
  streamPaths,
  ffmpegVersion,
  type FfmpegHandle,
} from "./ffmpeg";
import { mediaById, absPath } from "./media";

export interface StreamRow {
  id: string;
  account_id: string;
  name: string;
  platform: string;
  rtmp_url: string;
  stream_key_enc: string;
  playlist_json: string;
  bitrate_kbps: number;
  resolution: string;
  fps: number;
  loop_forever: number;
  state: string;
  ffmpeg_pid: number | null;
  started_at: string | null;
  stopped_at: string | null;
  uptime_s: number;
  restart_count: number;
  last_error: string | null;
}

export interface PlaylistItem {
  mediaId: string;
  durationS?: number | null;
  label?: string;
}

export function streamById(id: string) {
  return one<StreamRow>("SELECT * FROM streams WHERE id = ?", id);
}

export function listStreams() {
  return all<StreamRow & { account_handle: string | null }>(
    `SELECT s.*, a.handle AS account_handle FROM streams s
     LEFT JOIN accounts a ON a.id = s.account_id ORDER BY s.created_at DESC`,
  );
}

/** Public projection: the stream key is never returned, only its last four characters. */
export function publicStream(row: StreamRow & Record<string, unknown>) {
  const key = decryptSecret(row.stream_key_enc);
  const { stream_key_enc, ...rest } = row as any;
  return { ...rest, stream_key_masked: maskSecret(key), has_key: Boolean(key) };
}

export function logEvent(streamId: string, level: string, message: string) {
  run("INSERT INTO stream_events (id, stream_id, level, message) VALUES (?, ?, ?, ?)", uid("sev"), streamId, level, message.slice(0, 2000));
}

const ALLOWED_SCHEME = /^(rtmps?|srt):\/\//i;
const ALLOWED_PLATFORM = /^[a-z0-9.\-_]{3,253}$/i;

/**
 * Private, loopback and link-local space. ffmpeg turns this hostname into an outbound
 * connection, so an operator-supplied ingest URL is an SSRF primitive unless it is pinned to
 * routable public infrastructure.
 */
const BLOCKED_HOSTNAMES = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();

  // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
    return false;
  }

  const octets = bare.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return false;
  const [a, b] = octets.map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata endpoints
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

/**
 * Ingest URLs come from the operator, and ffmpeg turns hostnames into network requests.
 * Restrict to streaming schemes and reject anything that is not a plain host[:port]/path -
 * this blocks file://, http://, pipe: and other protocol tricks.
 */
export function assertSafeIngest(url: string) {
  if (!ALLOWED_SCHEME.test(url)) throw new Error("ingest URL must start with rtmp://, rtmps:// or srt://");
  const withoutScheme = url.replace(ALLOWED_SCHEME, "");
  const host = withoutScheme.split("/")[0].split(":")[0];
  if (!ALLOWED_PLATFORM.test(host)) throw new Error("ingest URL host is not a valid hostname");
  if (/[\s"'`$\\]/.test(url)) throw new Error("ingest URL contains illegal characters");
  if (BLOCKED_HOSTNAMES.test(host)) throw new Error("ingest URL must not point at a local address");
  // ponytail: literal-address guard only; a name resolving into private space is a job for the
  // egress policy, add DNS-rebinding checks here if that layer is ever removed.
  if (isPrivateAddress(host)) throw new Error("ingest URL must not point at a private or loopback address");
  return url;
}

function resolvePlaylist(items: PlaylistItem[]) {
  const files: string[] = [];
  const durations: (number | null)[] = [];
  for (const item of items) {
    const media = mediaById(item.mediaId);
    if (!media) throw new Error(`playlist references missing media ${item.mediaId}`);
    if (!media.mime.startsWith("video/")) throw new Error(`${media.filename} is not a video asset`);
    const abs = absPath(media.rel_path);
    if (!fs.existsSync(abs)) throw new Error(`${media.filename} is missing from the media store`);
    files.push(abs);
    durations.push(item.durationS ?? media.duration_s ?? null);
  }
  if (!files.length) throw new Error("playlist is empty: add at least one video");
  return { files, durations };
}

/* -------------------------------------------------------------------------- */
/* supervisor                                                                  */
/* -------------------------------------------------------------------------- */

interface Running {
  handle: FfmpegHandle;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __socialdeckStreams: Map<string, Running> | undefined;
}

const running: Map<string, Running> = globalThis.__socialdeckStreams ?? (globalThis.__socialdeckStreams = new Map());

export function runningStreams() {
  return [...running.entries()].map(([id, r]) => ({ id, pid: r.handle.pid, uptimeS: Math.round((Date.now() - r.startedAt) / 1000) }));
}

export async function startStream(streamId: string, actor = "system") {
  const row = streamById(streamId);
  if (!row) throw new Error("stream not found");
  if (running.has(streamId)) return { ok: true, already: true };

  const key = decryptSecret(row.stream_key_enc);
  if (!key) throw new Error("stream has no key stored");
  assertSafeIngest(row.rtmp_url);

  const items = json<PlaylistItem[]>(row.playlist_json, []);
  const { files, durations } = resolvePlaylist(items);
  const paths = streamPaths(streamId);
  fs.mkdirSync(absPath("stream"), { recursive: true });
  await writePlaylist(paths.playlistFile, files, durations);

  run("UPDATE streams SET state = 'starting', last_error = NULL WHERE id = ?", streamId);
  logEvent(streamId, "info", `starting relay: ${items.length} item(s), ${row.bitrate_kbps}kbps ${row.resolution}@${row.fps}`);

  const handle = startLoopStream(
    {
      files,
      rtmpUrl: row.rtmp_url,
      streamKey: key,
      bitrateKbps: row.bitrate_kbps,
      resolution: row.resolution,
      fps: row.fps,
      loop: row.loop_forever === 1,
    },
    { playlistFile: paths.playlistFile, logFile: paths.logFile },
  );

  fs.writeFileSync(paths.logFile, `# stream ${streamId}\n# started ${new Date().toISOString()}\n`, "utf8");
  running.set(streamId, { handle, startedAt: Date.now() });
  run(
    "UPDATE streams SET state = 'live', ffmpeg_pid = ?, started_at = datetime('now'), stopped_at = NULL WHERE id = ?",
    handle.pid,
    streamId,
  );
  logEvent(streamId, "info", `relay live, ffmpeg pid ${handle.pid}`);
  audit({ actor, action: "stream.start", entity: "stream", entityId: streamId, detail: { pid: handle.pid } });

  // The compose file does not pipe to a log file: append stderr tail periodically.
  handle.onExit((code, signal) => {
    running.delete(streamId);
    const tail = handle.stderrTail(8).join(" | ");
    logEvent(streamId, code === 0 ? "info" : "error", `ffmpeg exited code=${code} signal=${signal} ${tail}`);
    const row2 = streamById(streamId);
    if (!row2) return;
    if (row2.state === "stopping") {
      run("UPDATE streams SET state = 'idle', ffmpeg_pid = NULL, stopped_at = datetime('now') WHERE id = ?", streamId);
      return;
    }
    const count = (row2.restart_count ?? 0) + 1;
    run(
      "UPDATE streams SET state = 'error', ffmpeg_pid = NULL, restart_count = ?, last_error = ? WHERE id = ?",
      count,
      `ffmpeg exit ${code}${tail ? `: ${tail}` : ""}`.slice(0, 1000),
      streamId,
    );
    audit({ actor: "system", action: "stream.crashed", entity: "stream", entityId: streamId, detail: { code, signal } });
    // Automatic recovery with backoff, capped so a permanently broken endpoint is not hammered.
    if (count <= 20) {
      const backoffMs = Math.min(5000 * count, 60000);
      logEvent(streamId, "warning", `restart attempt ${count} in ${Math.round(backoffMs / 1000)}s`);
      const timer = setTimeout(() => {
        const fresh = streamById(streamId);
        if (fresh && fresh.state === "error") void startStream(streamId, "supervisor");
      }, backoffMs);
      timer.unref?.();
    } else {
      logEvent(streamId, "error", "restart budget exhausted; operator action required");
    }
  });

  return { ok: true, pid: handle.pid };
}

export async function stopStream(streamId: string, actor = "system", reason = "operator") {
  const row = streamById(streamId);
  if (!row) throw new Error("stream not found");
  run("UPDATE streams SET state = 'stopping' WHERE id = ?", streamId);
  const entry = running.get(streamId);
  if (!entry) {
    run("UPDATE streams SET state = 'idle', ffmpeg_pid = NULL, stopped_at = datetime('now') WHERE id = ?", streamId);
    logEvent(streamId, "info", `stop requested but relay was not running (${reason})`);
    return { ok: true, wasRunning: false };
  }
  await entry.handle.stop();
  running.delete(streamId);
  run("UPDATE streams SET state = 'idle', ffmpeg_pid = NULL, stopped_at = datetime('now') WHERE id = ?", streamId);
  logEvent(streamId, "info", `relay stopped (${reason})`);
  audit({ actor, action: "stream.stop", entity: "stream", entityId: streamId, detail: { reason } });
  return { ok: true, wasRunning: true };
}

/** Reconcile DB intent with live children. Called on a timer by the worker. */
export async function supervise() {
  const live = new Set(running.keys());
  for (const row of listStreams()) {
    if (row.state === "live" || row.state === "starting") {
      const entry = running.get(row.id);
      if (!entry) continue; // an exit handler owns the restart path
      const exitCode = entry.handle.process.exitCode;
      if (exitCode !== null) {
        running.delete(row.id);
        continue;
      }
      const uptime = Math.round((Date.now() - entry.startedAt) / 1000);
      run("UPDATE streams SET uptime_s = ?, ffmpeg_pid = ? WHERE id = ?", uptime, entry.handle.pid, row.id);
      continue;
    }
    // Any stale handle for a stopped stream is cleaned up here.
    if (row.state === "idle" && live.has(row.id)) {
      const entry = running.get(row.id)!;
      await entry.handle.stop();
      running.delete(row.id);
    }
  }
}

/** End-to-end ingest check: pushes a 5 second synthetic test pattern to the target. */
export function testIngest(streamId: string): Promise<{ ok: boolean; output: string }> {
  const row = streamById(streamId);
  if (!row) throw new Error("stream not found");
  const key = decryptSecret(row.stream_key_enc);
  if (!key) throw new Error("stream has no key stored");
  assertSafeIngest(row.rtmp_url);
  const target = `${row.rtmp_url.replace(/\/+$/, "")}/${key}`;
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      env.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${row.resolution.replace("x", "x")}:rate=${row.fps}`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "5",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        `${row.bitrate_kbps}k`,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "flv",
        target,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let out = "";
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
    child.on("exit", (code) => {
      const ok = code === 0 && !/error|failed|refused|unable/i.test(out);
      logEvent(streamId, ok ? "info" : "error", `ingest test: exit=${code} ${out.split("\n").filter(Boolean).slice(-3).join(" | ")}`.slice(0, 1500));
      resolve({ ok, output: out.slice(-1500) });
    });
  });
}

/** Live telemetry per channel, keyed by stream id: what the console shows above the log. */
export function streamHealth(): Record<
  string,
  { status: string; bitrate_kbps: number | null; uptime_s: number; pid: number | null; lastError: string | null; restarts: number }
> {
  const out: Record<string, { status: string; bitrate_kbps: number | null; uptime_s: number; pid: number | null; lastError: string | null; restarts: number }> = {};
  for (const row of listStreams()) {
    const entry = running.get(row.id);
    const uptime = entry ? Math.round((Date.now() - entry.startedAt) / 1000) : Number(row.uptime_s ?? 0);
    out[row.id] = {
      status: entry ? "live" : entry === undefined && row.state === "starting" ? "starting" : row.state,
      // ffmpeg reports live bitrate on stderr; until that probe lands we publish the target rate.
      bitrate_kbps: entry ? Number(row.bitrate_kbps ?? 0) : null,
      uptime_s: uptime,
      pid: entry?.handle.pid ?? (row.ffmpeg_pid ? Number(row.ffmpeg_pid) : null),
      lastError: (row.last_error as string | null) ?? null,
      restarts: Number(row.restart_count ?? 0),
    };
  }
  return out;
}

/** Runtime capabilities of the supervisor itself, surfaced on the queue page. */
export function streamRuntime() {
  return {
    ffmpeg: ffmpegVersion(),
    running: runningStreams(),
    allowLive: env.outboundMode === "live",
  };
}

export { encryptSecret, maskSecret };
