import { all, one, run, uid, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { publicStream, assertSafeIngest, listStreams, streamHealth, startStream, stopStream, testIngest, streamById, logEvent } from "@/lib/streams";
import { RTMP_TARGETS } from "@/lib/rtmp-targets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  await requireRole();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id && url.searchParams.get("events") === "1") {
    const events = all<{ id: string; kind: string; message: string; created_at: string }>(
      "SELECT id, level AS kind, message, ts AS created_at FROM stream_events WHERE stream_id = ? ORDER BY ts DESC LIMIT 120",
      id,
    );
    return ok({ events });
  }

  const health = streamHealth();
  const streams = listStreams().map((s) => {
    const pub = publicStream(s as any) as Record<string, unknown>;
    const state = String(pub.state ?? "idle");
    return {
      id: String(pub.id),
      name: String(pub.name),
      state,
      // The console reads `status`; the database column is `state`.
      status: state,
      platform: String(pub.platform ?? "custom"),
      target: String(pub.platform ?? "custom"),
      server_url: String(pub.rtmp_url ?? ""),
      stream_key_masked: String(pub.stream_key_masked ?? ""),
      resolution: String(pub.resolution ?? "1920x1080"),
      fps: Number(pub.fps ?? 30),
      bitrate_kbps: Number(pub.bitrate_kbps ?? 0),
      loop: pub.loop_forever === 1,
      restart_on_failure: true,
      uptime_s: health[String(pub.id)]?.uptime_s ?? 0,
      last_started_at: (pub.started_at as string | null) ?? null,
      last_error: (pub.last_error as string | null) ?? null,
      restarts: Number(pub.restart_count ?? 0),
      health: health[String(pub.id)] ?? null,
      playlist: json<{ mediaId: string; durationS?: number }[]>(s.playlist_json as string, []).map((item) => ({
        mediaId: item.mediaId,
        duration: item.durationS ?? null,
        filename: one<{ filename: string }>("SELECT filename FROM media WHERE id = ?", item.mediaId)?.filename ?? item.mediaId,
      })),
    };
  });

  const media = all<{ id: string; filename: string; kind: string; duration_s: number | null; size_bytes: number; width: number | null; height: number | null }>(
    "SELECT id, filename, kind, duration_s, bytes AS size_bytes, width, height FROM media WHERE kind = 'video' ORDER BY created_at DESC LIMIT 300",
  );

  return ok({ streams, media, targets: RTMP_TARGETS });
});

export const POST = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<{
    name?: string;
    target?: string;
    serverUrl?: string;
    streamKey?: string;
    bitrate?: number;
    resolution?: string;
    fps?: number;
    audioBitrate?: number;
    loop?: boolean;
    restartOnFailure?: boolean;
    mediaIds?: string[];
  }>(req);

  if (!body.name || !body.serverUrl || !body.streamKey) {
    return fail(400, "name, serverUrl and streamKey are required");
  }
  if (!Array.isArray(body.mediaIds) || body.mediaIds.length === 0) return fail(400, "select at least one video for the playlist");
  try {
    assertSafeIngest(body.serverUrl);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : "unsafe ingest URL");
  }

  // A channel needs an account row to hang off; RTMP targets are the credential-free case.
  const target = body.target ?? "custom";
  const externalId = `rtmp:${target}:${uid("").slice(0, 8)}`;
  let accountId = one<{ id: string }>("SELECT id FROM accounts WHERE platform = ? AND external_id = ?", "rtmp", externalId)?.id;
  if (!accountId) {
    accountId = uid("acc");
    run(
      `INSERT INTO accounts (id, platform, external_id, handle, display_name, account_type, access_token_enc, status, meta_json)
       VALUES (?, 'rtmp', ?, ?, ?, 'channel', ?, 'connected', '{}')`,
      accountId,
      externalId,
      body.name,
      body.name,
      encryptSecret(body.streamKey),
    );
  }

  const id = uid("stm");
  run(
    `INSERT INTO streams (id, account_id, name, platform, rtmp_url, stream_key_enc, playlist_json, bitrate_kbps,
       resolution, fps, loop_forever, state, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?)`,
    id,
    accountId,
    body.name,
    target,
    body.serverUrl,
    encryptSecret(body.streamKey),
    JSON.stringify(body.mediaIds.map((mediaId) => ({ mediaId }))),
    Number(body.bitrate ?? 3500),
    body.resolution ?? "1920x1080",
    Number(body.fps ?? 30),
    body.loop === false ? 0 : 1,
    user.id,
  );
  logEvent(id, "info", `channel created: ${body.mediaIds.length} item(s), ${body.resolution ?? "1920x1080"}@${body.fps ?? 30}`);
  audit({ userId: user.id, action: "stream.created", entity: "stream", entityId: id, detail: { name: body.name, target } });
  return ok({ id }, { status: 201 });
});

export const PATCH = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<Record<string, any>>(req);
  if (!body.id) return fail(400, "id is required");
  const existing = one<any>("SELECT * FROM streams WHERE id = ?", body.id);
  if (!existing) return fail(404, "stream not found");
  if (existing.state === "live" || existing.state === "starting") return fail(409, "stop the channel before editing it");
  if (body.serverUrl) {
    try {
      assertSafeIngest(body.serverUrl);
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : "unsafe ingest URL");
    }
  }
  run(
    `UPDATE streams SET name = ?, rtmp_url = ?, stream_key_enc = COALESCE(?, stream_key_enc),
       playlist_json = COALESCE(?, playlist_json), bitrate_kbps = ?, resolution = ?, fps = ?, loop_forever = ?
     WHERE id = ?`,
    body.name ?? existing.name,
    body.serverUrl ?? existing.rtmp_url,
    body.streamKey ? encryptSecret(body.streamKey) : null,
    body.mediaIds ? JSON.stringify(body.mediaIds.map((mediaId: string) => ({ mediaId }))) : null,
    Number(body.bitrate ?? existing.bitrate_kbps),
    body.resolution ?? existing.resolution,
    Number(body.fps ?? existing.fps),
    body.loop === undefined ? existing.loop_forever : body.loop ? 1 : 0,
    body.id,
  );
  audit({ userId: user.id, action: "stream.updated", entity: "stream", entityId: body.id });
  return ok({ updated: true });
});

export const DELETE = route(async (req: Request) => {
  const user = await requireRole("owner", "admin");
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail(400, "id is required");
  const row = one<any>("SELECT state FROM streams WHERE id = ?", id);
  if (!row) return fail(404, "stream not found");
  // Stopping first is the difference between a clean shutdown and an orphaned encoder.
  if (row.state === "live" || row.state === "starting") await stopStream(id, `user:${user.id}`, "deleted");
  run("DELETE FROM streams WHERE id = ?", id);
  audit({ userId: user.id, action: "stream.deleted", entity: "stream", entityId: id });
  return ok({ deleted: id });
});

/** Per-channel actions live on the collection route so the console has one URL to call. */
export const PUT = route(async (req: Request) => {
  const user = await requireRole("owner", "admin", "operator");
  const body = await readJson<{ id?: string; action?: "start" | "stop" | "test" | "restart" }>(req);
  if (!body.id || !body.action) return fail(400, "id and action are required");
  const row = streamById(body.id);
  if (!row) return fail(404, "stream not found");

  switch (body.action) {
    case "start":
      return ok(await startStream(body.id, `user:${user.id}`));
    case "stop":
      return ok(await stopStream(body.id, `user:${user.id}`, "console"));
    case "restart":
      await stopStream(body.id, `user:${user.id}`, "restart");
      return ok(await startStream(body.id, `user:${user.id}`));
    case "test":
      return ok(await testIngest(body.id));
    default:
      return fail(400, "unknown action");
  }
});
