import { NextResponse } from "next/server";
import { migrate, one } from "@/lib/db";
import { queueHealth } from "@/lib/queue";
import { probeFfmpeg } from "@/lib/ffmpeg";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe. Reads queue state from the SQL ledger rather than touching a live
 * Redis connection: the health endpoint must answer even when the broker is down.
 * The ffmpeg probe is awaited, otherwise the first response reports a false negative.
 */
export const GET = async () => {
  try {
    migrate();
    const ffmpeg = await probeFfmpeg();
    const counts = one<{ jobs: number; streams: number; accounts: number; posts: number }>(
      `SELECT
         (SELECT COUNT(*) FROM job_runs) AS jobs,
         (SELECT COUNT(*) FROM streams) AS streams,
         (SELECT COUNT(*) FROM accounts) AS accounts,
         (SELECT COUNT(*) FROM posts) AS posts`,
    );
    return NextResponse.json({
      ok: true,
      version: "1.0.0",
      outboundMode: env.outboundMode,
      queue: queueHealth(),
      ffmpeg,
      ffmpegPath: env.ffmpegPath,
      ffmpegPresent: Boolean(ffmpeg),
      dataDir: env.dataDir,
      counts: counts ?? { jobs: 0, streams: 0, accounts: 0, posts: 0 },
      now: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
