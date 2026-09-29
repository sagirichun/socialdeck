"use client";

import React, { useMemo, useState } from "react";
import {
  Activity,
  Clock,
  Film,
  Gauge,
  Layers,
  Pause,
  Play,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  SignalHigh,
  Trash2,
  Wifi,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  Drawer,
  EmptyState,
  Field,
  Grid,
  Input,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Toggle,
  Tr,
  statusTone,
  cn,
} from "@/components/ui";
import { api, fmtDateTime, fmtNumber, fmtRelative, useApi, useToast } from "@/lib/client";

interface Media {
  id: string;
  filename: string;
  kind: string;
  duration_s: number | null;
  size_bytes: number;
  width: number | null;
  height: number | null;
}

interface RtmpTarget {
  key: string;
  label: string;
  server: string;
  preset: { resolution: string; videoBitrate: string; audioBitrate: string; fps: number };
}

interface Stream {
  id: string;
  name: string;
  status: string;
  target: string;
  server_url: string;
  bitrate_kbps: number;
  resolution: string;
  loop: number;
  restart_on_failure: number;
  uptime_s: number | null;
  last_started_at: string | null;
  last_error: string | null;
  health: { status: string; bitrate_kbps: number | null; uptime_s: number | null; pid: number | null; lastError: string | null; restarts: number } | null;
  playlist: { mediaId: string; filename: string; duration: number | null }[];
}

export default function StreamsPage() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    target: "youtube",
    serverUrl: "rtmp://a.rtmp.youtube.com/live2",
    streamKey: "",
    bitrate: "6000",
    resolution: "1920x1080",
    fps: "30",
    audioBitrate: "160",
    loop: true,
    restartOnFailure: true,
    mediaIds: [] as string[],
  });

  const { data, loading, reload } = useApi<{ streams: Stream[]; media: Media[]; targets: RtmpTarget[] }>("/api/streams", [], { pollMs: 8000 });
  const { data: events } = useApi<{ events: { id: string; kind: string; message: string; created_at: string }[] }>(
    logFor ? `/api/streams/${logFor}?events=1` : null,
    [logFor],
    { pollMs: 5000 },
  );

  const streams = data?.streams ?? [];
  const videos = (data?.media ?? []).filter((m) => m.kind === "video");
  const live = streams.filter((s) => s.status === "live");

  const create = async () => {
    setBusy("create");
    try {
      await api.post("/api/streams", {
        name: form.name || "Untitled channel",
        target: form.target,
        serverUrl: form.serverUrl,
        streamKey: form.streamKey,
        bitrate: Number(form.bitrate),
        resolution: form.resolution,
        fps: Number(form.fps),
        audioBitrate: Number(form.audioBitrate),
        loop: form.loop,
        restartOnFailure: form.restartOnFailure,
        mediaIds: form.mediaIds,
      });
      toast.push("good", "Stream channel created. Add a video to the playlist and start it.");
      setOpen(false);
      setForm({ ...form, name: "", streamKey: "", mediaIds: [] });
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not create the channel");
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, action: string) => {
    setBusy(id + action);
    try {
      const res = await api.post<{ ok?: boolean; error?: string; simulated?: boolean }>(`/api/streams/${id}`, { action });
      if (action === "start") {
        if (res?.simulated) toast.push("info", "ffmpeg is not installed here, so the supervisor ran in simulation mode. The playlist and timing logic were still exercised.");
        else toast.push("good", "Encoder started and publishing to the RTMP ingest.");
      } else if (action === "stop") toast.push("good", "Encoder stopped cleanly.");
      else if (action === "test") toast.push(res?.ok ? "good" : "bad", res?.ok ? "Ingest reachable and accepting the stream key." : res?.error ?? "Ingest rejected the connection.");
      else toast.push("good", "Channel restarted.");
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api.del(`/api/streams/${id}`);
      toast.push("good", "Channel deleted and its encoder stopped.");
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Live channels"
        description="Loop a recorded playlist into any RTMP ingest around the clock. The supervisor restarts the encoder with backoff and falls back across items if one file is unreadable."
        meta={
          <>
            <span className={cn("inline-flex items-center gap-1.5", live.length ? "text-bad" : "")}>
              <Radio size={11} /> {live.length} on air
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Film size={11} /> {videos.length} videos in the library
            </span>
          </>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            New channel
          </Button>
        }
      />

      <Grid cols={4} className="mb-3">
        <StatTile label="Channels" value={streams.length} hint="configured RTMP outputs" icon={Radio} />
        <StatTile label="On air" value={live.length} tone={live.length ? "bad" : "muted"} hint="encoders publishing now" icon={SignalHigh} />
        <StatTile
          label="Aggregate bitrate"
          value={fmtNumber(live.reduce((acc, s) => acc + (s.health?.bitrate_kbps ?? 0), 0)) + " kbps"}
          hint="sum of live encoders"
          icon={Gauge}
        />
        <StatTile
          label="Restarts"
          value={streams.reduce((acc, s) => acc + (s.health?.restarts ?? 0), 0)}
          tone={streams.some((s) => (s.health?.restarts ?? 0) > 0) ? "warn" : "good"}
          hint="automatic recoveries"
          icon={RotateCcw}
        />
      </Grid>

      <Card className="mb-3">
        <CardHeader title="Channels" subtitle="Each channel is one encoder process with its own playlist and health telemetry" icon={Wifi} />
        {loading && !data ? (
          <CardBody>
            <Skeleton className="h-32" />
          </CardBody>
        ) : streams.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th>State</Th>
                <Th>Output</Th>
                <Th>Playlist</Th>
                <Th>Health</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <span className="block text-ink">{s.name}</span>
                    <span className="block text-[10.5px] text-ink-faint">{s.resolution} - {s.bitrate_kbps} kbps</span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(s.status)} dot>
                      {s.status}
                    </Badge>
                  </Td>
                  <Td className="max-w-[240px]">
                    <span className="block truncate font-mono text-[10.5px] text-ink-mute">{s.server_url}</span>
                  </Td>
                  <Td>
                    <span className="tnum text-ink-faint">{s.playlist.length} item(s)</span>
                    <button
                      className="ml-2 text-[11px] text-accent hover:underline"
                      onClick={() => setLogFor(logFor === s.id ? null : s.id)}
                    >
                      {logFor === s.id ? "hide log" : "log"}
                    </button>
                  </Td>
                  <Td>
                    {s.health?.status === "live" ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="tnum text-[11px] text-ink-dim">{s.health.bitrate_kbps ?? s.bitrate_kbps} kbps</span>
                        <span className="text-[10.5px] text-ink-faint">
                          up {Math.floor((s.health.uptime_s ?? 0) / 3600)}h {Math.floor(((s.health.uptime_s ?? 0) % 3600) / 60)}m
                        </span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-ink-faint">{s.last_error ? <span className="font-mono text-bad">{s.last_error.slice(0, 40)}</span> : "idle"}</span>
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      {s.status === "live" ? (
                        <Button size="sm" variant="ghost" icon={Pause} loading={busy === s.id + "stop"} onClick={() => act(s.id, "stop")}>
                          Stop
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" icon={Play} loading={busy === s.id + "start"} onClick={() => act(s.id, "start")}>
                          Start
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" icon={PlugZap} loading={busy === s.id + "test"} onClick={() => act(s.id, "test")}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === s.id + "restart"} onClick={() => act(s.id, "restart")}>
                        Restart
                      </Button>
                      <ConfirmButton label="Delete" confirmLabel="Confirm" variant="ghost" icon={Trash2} onConfirm={() => remove(s.id)} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Radio}
            title="No channels yet"
            description="Create a channel, pick the looped playlist, and the supervisor keeps it on air."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                New channel
              </Button>
            }
          />
        )}
      </Card>

      {logFor ? (
        <Card>
          <CardHeader
            title="Encoder log"
            subtitle="Structured events from the supervisor: start attempts, fallbacks, failures and recoveries"
            icon={Activity}
            actions={
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reload}>
                Refresh
              </Button>
            }
          />
          <CardBody>
            <ul className="flex flex-col gap-1.5">
              {(events?.events ?? []).map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 font-mono text-[11px]">
                  <span className="w-[130px] shrink-0 text-ink-faint">{fmtDateTime(e.created_at)}</span>
                  <Badge tone={e.kind === "error" ? "bad" : e.kind === "warn" ? "warn" : "muted"}>{e.kind}</Badge>
                  <span className="text-ink-dim">{e.message}</span>
                </li>
              ))}
              {!events?.events.length ? <li className="text-[12px] text-ink-faint">No events recorded for this channel yet.</li> : null}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="New live channel"
        description="Pick a preset for the target network or paste a custom RTMP server. The stream key is encrypted and never displayed again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Radio} loading={busy === "create"} onClick={create}>
              Create channel
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="Channel name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Always-on product feed" />
          </Field>
          <Field label="Target network">
            <Select
              value={form.target}
              onChange={(e) => {
                const t = (data?.targets ?? []).find((x) => x.key === e.target.value);
                setForm({
                  ...form,
                  target: e.target.value,
                  serverUrl: t?.server ?? form.serverUrl,
                  resolution: t?.preset.resolution ?? form.resolution,
                  bitrate: t?.preset.videoBitrate ?? form.bitrate,
                  audioBitrate: t?.preset.audioBitrate ?? form.audioBitrate,
                  fps: String(t?.preset.fps ?? form.fps),
                });
              }}
            >
              {(data?.targets ?? []).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="RTMP server URL">
            <Input value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} />
          </Field>
          <Field label="Stream key" hint="Encrypted at rest, masked in every response">
            <PasswordInput value={form.streamKey} onChange={(e) => setForm({ ...form, streamKey: e.target.value })} placeholder="paste stream key" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Resolution">
              <Select value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })}>
                {["1920x1080", "1280x720", "1080x1920", "720x1280", "854x480"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Video bitrate (kbps)">
              <Input value={form.bitrate} onChange={(e) => setForm({ ...form, bitrate: e.target.value })} />
            </Field>
            <Field label="Frame rate">
              <Select value={form.fps} onChange={(e) => setForm({ ...form, fps: e.target.value })}>
                {["24", "25", "30", "50", "60"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Audio bitrate (kbps)">
              <Input value={form.audioBitrate} onChange={(e) => setForm({ ...form, audioBitrate: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            {(
              [
                ["loop", "Loop the playlist forever"],
                ["restartOnFailure", "Restart automatically after a failure"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
                <Toggle checked={form[key]} onChange={(v) => setForm({ ...form, [key]: v })} label={label} />
                <span className="text-[12.5px] text-ink-dim">{label}</span>
              </label>
            ))}
          </div>
          <Field label="Playlist" hint="Order matters; the encoder walks the list and loops at the end">
            <div className="max-h-56 overflow-y-auto rounded-[7px] border border-line">
              {videos.length ? (
                videos.map((m) => {
                  const selected = form.mediaIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          mediaIds: selected ? form.mediaIds.filter((x) => x !== m.id) : [...form.mediaIds, m.id],
                        })
                      }
                      className={cn(
                        "flex w-full items-center gap-2.5 border-b border-line px-3 py-2 text-left last:border-b-0",
                        selected ? "bg-accent-soft" : "hover:bg-raised",
                      )}
                    >
                      <span className={cn("h-3.5 w-3.5 rounded-[3px] border", selected ? "border-accent bg-accent" : "border-line-strong")} />
                      <Film size={13} className="text-ink-faint" />
                      <span className="flex-1 truncate text-[12px] text-ink-dim">{m.filename}</span>
                      <span className="tnum text-[11px] text-ink-faint">
                        {m.duration_s ? `${Math.round(m.duration_s)}s` : "-"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-3 text-[12px] text-ink-faint">No videos uploaded yet. Upload one in the media library first.</p>
              )}
            </div>
          </Field>
        </div>
      </Drawer>
    </>
  );
}
