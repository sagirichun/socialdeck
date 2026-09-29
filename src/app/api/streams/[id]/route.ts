import { one, run, audit, json } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { ok, fail, route, readJson } from "@/lib/api";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";
import { publicStream, assertSafeIngest, startStream, stopStream, testIngest, streamById, logEvent, runningStreams } from "@/lib/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole();
  const { id } = await ctx.params;
  const row = streamById(id);
  if (!row) return fail(404, "stream not found");
  return ok({
    ...publicStream(row as never),
    playlist: json<{ mediaId: string; durationS?: number }[]>(row.playlist_json as string, []),
    stream_key_masked: maskSecret(decryptSecret(row.stream_key_enc)),
    health: runningStreams().find((s) => s.id === id) ?? null,
  });
});

export const PATCH = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const body = await readJson<{
    name?: string;
    serverUrl?: string;
    streamKey?: string;
    bitrate?: number;
    resolution?: string;
    fps?: number;
    loop?: boolean;
    mediaIds?: string[];
  }>(req);
  const existing = one<any>("SELECT * FROM streams WHERE id = ?", id);
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
    id,
  );
  const user = await requireRole();
  audit({ userId: user.id, action: "stream.updated", entity: "stream", entityId: id });
  return ok({ updated: true });
});

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin", "operator");
  const { id } = await ctx.params;
  const body = await readJson<{ action?: "start" | "stop" | "restart" | "test" }>(req);
  const row = streamById(id);
  if (!row) return fail(404, "stream not found");

  switch (body.action) {
    case "start":
      return ok(await startStream(id, `user:${user.id}`));
    case "stop":
      return ok(await stopStream(id, `user:${user.id}`, "console"));
    case "restart":
      await stopStream(id, `user:${user.id}`, "restart");
      return ok(await startStream(id, `user:${user.id}`));
    case "test":
      return ok(await testIngest(id));
    default:
      return fail(400, "unknown action");
  }
});

export const DELETE = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("owner", "admin");
  const { id } = await ctx.params;
  const row = one<any>("SELECT state FROM streams WHERE id = ?", id);
  if (!row) return fail(404, "stream not found");
  if (row.state === "live" || row.state === "starting") await stopStream(id, `user:${user.id}`, "deleted");
  run("DELETE FROM streams WHERE id = ?", id);
  logEvent(id, "info", "channel deleted");
  audit({ userId: user.id, action: "stream.deleted", entity: "stream", entityId: id });
  return ok({ deleted: id });
});
