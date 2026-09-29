import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { env } from "./env";

/**
 * ffmpeg driver. The supervisor is intentionally thin: build a deterministic argument list,
 * track the child, and surface its stderr to the operator. Nothing here decides policy -
 * the stream service owns that.
 */

export interface LoopStreamInput {
  /** Absolute paths of the media files that form the playlist, in order. */
  files: string[];
  /** Per-file duration override in seconds (used by -stream_loop on the whole list). */
  rtmpUrl: string;
  streamKey: string;
  bitrateKbps: number;
  resolution: string;
  fps: number;
  audioBitrateKbps?: number;
  preset?: string;
  /** Loop the playlist forever instead of ending after one pass. */
  loop?: boolean;
}

/**
 * Builds the concat demuxer playlist. Re-encoding is required because RTMP ingest rejects
 * arbitrary codec combinations, so we normalise to H.264/AAC at the target bitrate.
 */
export function buildArgs(input: LoopStreamInput, playlistFile: string, logFile: string): string[] {
  const gop = Math.max(1, Math.round(input.fps * 2));
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-re",
  ];
  if (input.loop !== false) args.push("-stream_loop", "-1");
  args.push(
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    playlistFile,
    "-c:v",
    "libx264",
    "-preset",
    input.preset ?? "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    `${input.bitrateKbps}k`,
    "-maxrate",
    `${input.bitrateKbps}k`,
    "-bufsize",
    `${input.bitrateKbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop),
    "-s",
    input.resolution,
    "-r",
    String(input.fps),
    "-c:a",
    "aac",
    "-b:a",
    `${input.audioBitrateKbps ?? 128}k`,
    "-ar",
    "44100",
    "-f",
    "flv",
    `${input.rtmpUrl.replace(/\/+$/, "")}/${input.streamKey}`,
  );
  return args;
}

export interface FfmpegHandle {
  pid: number | null;
  process: ChildProcess;
  stop(): Promise<void>;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  stderrTail(lines?: number): string[];
}

export function startLoopStream(input: LoopStreamInput, opts: { playlistFile: string; logFile: string }): FfmpegHandle {
  const args = buildArgs(input, opts.playlistFile, opts.logFile);
  const child = spawn(env.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  const tail: string[] = [];
  child.stderr?.on("data", (buf: Buffer) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      tail.push(line.trim());
      if (tail.length > 400) tail.shift();
    }
  });

  return {
    pid: child.pid ?? null,
    process: child,
    stderrTail: (n = 40) => tail.slice(-n),
    onExit: (cb) => {
      child.on("exit", (code, signal) => cb(code, signal));
      child.on("error", () => cb(-1, null));
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.killed) return resolve();
        const killer = setTimeout(() => child.kill("SIGKILL"), 6000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

/** Probe a media file for the metadata the UI shows (width, height, duration). */
export function probe(file: string): Promise<{ width?: number; height?: number; durationS?: number; streams?: number }> {
  return new Promise((resolve) => {
    const child = spawn(env.ffmpegPath.replace(/ffmpeg$/, "ffprobe"), [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({}));
    child.on("exit", () => {
      try {
        const parsed = JSON.parse(out);
        const stream = parsed.streams?.[0] ?? {};
        const duration = Number(parsed.format?.duration ?? stream.duration);
        resolve({
          width: stream.width,
          height: stream.height,
          durationS: Number.isFinite(duration) ? duration : undefined,
          streams: parsed.streams?.length,
        });
      } catch {
        resolve({});
      }
    });
  });
}

/** Write a concat-demuxer playlist file (paths must be quoted for ffmpeg). */
export async function writePlaylist(file: string, files: string[], durations: (number | null)[]): Promise<void> {
  const fs = await import("node:fs");
  const lines: string[] = [];
  files.forEach((f, i) => {
    const d = durations[i];
    if (d && d > 0) lines.push(`file '${f.replace(/'/g, "'\\''")}'`, `duration ${d.toFixed(3)}`);
    else lines.push(`file '${f.replace(/'/g, "'\\''")}'`);
  });
  // The demuxer needs the final file repeated so the last duration is honoured.
  if (files.length) lines.push(`file '${files[files.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

let ffmpegProbe: string | null = null;

/** Sync lookup used by request handlers and status screens; probed once, cached for the process. */
export function ffmpegVersion(): string | null {
  return ffmpegProbe;
}

/** Probe the binary at boot. Returns the version banner, or null when ffmpeg is absent. */
export async function probeFfmpeg(): Promise<string | null> {
  if (ffmpegProbe) return ffmpegProbe;
  ffmpegProbe = await new Promise<string | null>((resolve) => {
    const child = spawn(env.ffmpegPath, ["-version"]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? (out.split("\n")[0] ?? "ffmpeg") : null));
  });
  return ffmpegProbe;
}

export const streamPaths = (id: string) => ({
  playlistFile: path.join(env.mediaDir, "stream", `${id}.txt`),
  logFile: path.join(env.mediaDir, "stream", `${id}.log`),
});
