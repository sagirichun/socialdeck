import fs from "node:fs";
import { all, one, run, setSetting, setting } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { env } from "@/lib/env";
import { queueHealth } from "@/lib/queue";
import { ffmpegVersion } from "@/lib/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole();
  const counts = one<any>(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM accounts) AS accounts,
            (SELECT COUNT(*) FROM posts) AS posts,
            (SELECT COUNT(*) FROM ai_rules) AS rules,
            (SELECT COUNT(*) FROM streams) AS streams,
            (SELECT COUNT(*) FROM media) AS media`,
  );
  return ok({
    workspace: {
      name: setting("workspace.name") ?? "SocialDeck",
      url: setting("workspace.url") ?? env.appUrl,
      outboundMode: env.outboundMode,
      timezone: setting("workspace.timezone") ?? "Asia/Jakarta",
      dataDir: env.dataDir,
      mediaDir: env.mediaDir,
      redis: queueHealth().mode === "redis",
      ffmpeg: ffmpegVersion(),
      retentionDays: Number(setting("workspace.retentionDays") ?? 90),
    },
    accounts: all(
      "SELECT id, platform, handle, status, token_expires_at FROM accounts ORDER BY platform, handle",
    ),
    counts: {
      users: Number(counts?.users ?? 0),
      accounts: Number(counts?.accounts ?? 0),
      posts: Number(counts?.posts ?? 0),
      rules: Number(counts?.rules ?? 0),
      streams: Number(counts?.streams ?? 0),
      media: Number(counts?.media ?? 0),
    },
  });
});

export const PATCH = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const body = await readJson<{ name?: string; url?: string; timezone?: string; retentionDays?: number }>(req);

  if (body.name !== undefined) setSetting("workspace.name", String(body.name).slice(0, 120));
  if (body.url !== undefined) {
    // The base URL is handed to platforms so they can fetch media; it must be absolute.
    try {
      const parsed = new URL(String(body.url));
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("scheme");
      setSetting("workspace.url", parsed.origin);
    } catch {
      return fail(400, "url must be an absolute http(s) origin");
    }
  }
  if (body.timezone !== undefined) setSetting("workspace.timezone", String(body.timezone).slice(0, 64));
  if (body.retentionDays !== undefined) {
    const days = Number(body.retentionDays);
    if (!Number.isFinite(days) || days < 7 || days > 3650) return fail(400, "retentionDays must be between 7 and 3650");
    setSetting("workspace.retentionDays", String(Math.round(days)));
  }
  run(
    "INSERT INTO audit_logs (id, user_id, actor, action, entity, detail_json) VALUES (?, ?, ?, 'settings.updated', 'settings', ?)",
    `aud_${Math.random().toString(36).slice(2, 10)}`,
    user.id,
    user.email,
    JSON.stringify(body),
  );
  return ok({ updated: true });
});
