"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Film,
  ImageIcon,
  Link2,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Grid,
  IconButton,
  Input,
  KeyValue,
  Modal,
  PageHeader,
  Select,
  Switch,
  Tabs,
  Textarea,
  statusTone,
  cn,
} from "@/components/ui";
import { PlatformIcon, platformLabel } from "@/components/platforms";
import { api, fmtBytes, fmtDateTime, fmtDuration, useApi, useToast } from "@/lib/client";

interface Account {
  id: string;
  platform: string;
  handle: string | null;
  display_name: string | null;
  status: string;
}

interface MediaRow {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  createdAt: string;
  url: string;
}

const DRAFT_MODES = [
  { key: "draft", label: "Full draft" },
  { key: "variants", label: "Three variants" },
  { key: "hashtags", label: "Hashtags" },
  { key: "improve", label: "Tighten" },
  { key: "translate", label: "Translate" },
];

export default function ComposerPage() {
  const toast = useToast();
  const accountsQ = useApi<{ accounts: Account[] }>("/api/accounts");
  const mediaQ = useApi<{ media: MediaRow[] }>("/api/media");
  const providersQ = useApi<{ providers: { id: string; name: string; isDefault: boolean }[] }>("/api/ai/providers");

  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [kind, setKind] = useState("text");
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [campaign, setCampaign] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [saveAsDraft, setSaveAsDraft] = useState(false);
  const [busy, setBusy] = useState(false);

  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("professional");
  const [mode, setMode] = useState("draft");
  const [providerId, setProviderId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const accounts = accountsQ.data?.accounts ?? [];
  const selected = useMemo(() => accounts.filter((a) => accountIds.includes(a.id)), [accounts, accountIds]);
  const mediaRows = mediaQ.data?.media ?? [];
  const attached = mediaRows.filter((m) => mediaIds.includes(m.id));

  // Attaching media implies a media post; keep the kind honest without fighting the user.
  useEffect(() => {
    if (!mediaIds.length) return;
    const first = attached[0];
    if (!first) return;
    if (first.mime.startsWith("video/")) setKind((k) => (k === "video" || k === "reel" || k === "short" || k === "story" ? k : "video"));
    else setKind((k) => (k === "image" || k === "story" ? k : "image"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaIds.join(",")]);

  const limits = useMemo(() => {
    const caps: Record<string, number> = {
      x: 280,
      instagram: 2200,
      threads: 500,
      tiktok: 2200,
      youtube: 5000,
      facebook: 63206,
      linkedin: 3000,
    };
    const min = selected.reduce((acc, a) => Math.min(acc, caps[a.platform] ?? 3000), 3000);
    return min;
  }, [selected]);

  const overLimit = body.length > limits;

  const submit = async (publishNow: boolean) => {
    if (!accountIds.length) return toast.push("bad", "Select at least one target account.");
    if (!body.trim() && !mediaIds.length) return toast.push("bad", "Add text or attach media.");
    if (overLimit) return toast.push("bad", `Body exceeds the ${limits} character limit for the selected accounts.`);
    setBusy(true);
    try {
      const results: { accountId: string; ok: boolean; error?: string }[] = [];
      for (const accountId of accountIds) {
        try {
          await api.post("/api/posts", {
            accountId,
            kind,
            body,
            title: title || undefined,
            linkUrl: linkUrl || undefined,
            campaign: campaign || undefined,
            media: mediaIds.map((id) => ({ mediaId: id })),
            scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
            publishNow,
          });
          results.push({ accountId, ok: true });
        } catch (err) {
          results.push({ accountId, ok: false, error: (err as { message?: string }).message });
        }
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.push("bad", `${failed.length} of ${results.length} targets failed: ${failed[0].error ?? "unknown"}`);
      } else {
        toast.push(
          "good",
          publishNow
            ? `Publishing to ${results.length} account${results.length > 1 ? "s" : ""}.`
            : scheduledAt
              ? `Scheduled for ${fmtDateTime(new Date(scheduledAt).toISOString())} on ${results.length} target(s).`
              : `Queued on ${results.length} target(s).`,
        );
        setBody("");
        setMediaIds([]);
        setTitle("");
      }
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!brief.trim() && !body.trim()) return toast.push("bad", "Describe what the post should say.");
    setGenerating(true);
    try {
      const res = await api.put<{ text: string; model: string }>("/api/ai/providers", {
        mode,
        prompt: brief || undefined,
        current: body || undefined,
        platform: selected[0]?.platform,
        tone,
        language: selected[0]?.platform === "tiktok" ? "id" : undefined,
        providerId: providerId || undefined,
      });
      if (mode === "draft" || mode === "improve" || mode === "translate") setBody(res.text);
      else if (mode === "hashtags") setBody((prev) => `${prev.trimEnd()}\n\n${res.text}`.trim());
      else setBody(res.text);
      toast.push("good", `Drafted with ${res.model}.`);
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const row = await api.upload<MediaRow>("/api/media", file);
      await mediaQ.reload();
      setMediaIds((prev) => [...new Set([...prev, row.id])]);
      toast.push("good", `${row.filename} uploaded.`);
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Composer"
        description="Write once, target many accounts. The queue owns the timing; the platform adapter owns the API shape."
        meta={
          <>
            <span>{selected.length} target(s) selected</span>
            <span className={cn("tnum", overLimit && "text-bad")}>
              {body.length} / {limits} characters
            </span>
          </>
        }
        actions={
          <>
            <Button icon={CalendarClock} loading={busy && !saveAsDraft} disabled={!scheduledAt} onClick={() => submit(false)}>
              Schedule
            </Button>
            <Button variant="primary" icon={Send} loading={busy} onClick={() => submit(true)}>
              Publish now
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader
              title="Post content"
              subtitle="Character counting follows the strictest selected platform"
              icon={Type}
              actions={
                overLimit ? (
                  <Badge tone="bad">
                    <AlertTriangle size={11} /> over limit
                  </Badge>
                ) : null
              }
            />
            <CardBody className="flex flex-col gap-3.5">
              <Field label="Body" hint="Plain text. No markup is sent to the platforms.">
                <Textarea
                  rows={7}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="What should the audience read?"
                  className={cn(overLimit && "border-bad/50")}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <Tabs
                  tabs={DRAFT_MODES.map((m) => ({ key: m.key, label: m.label }))}
                  active={mode}
                  onChange={setMode}
                  className="flex-1 border-b-0"
                />
              </div>

              <div className="grid grid-cols-1 gap-2.5 rounded-[7px] border border-line bg-raised/60 p-3 sm:grid-cols-[1fr_150px_150px_auto]">
                <Input
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="Brief: what the post should say"
                />
                <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                  {["professional", "warm", "concise", "playful", "urgent"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">Default provider</option>
                  {(providersQ.data?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </Select>
                <Button icon={generating ? Loader2 : Sparkles} loading={generating} onClick={generate}>
                  Generate
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Title" hint="Used by video platforms">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label="Link" hint="Attached where the platform supports it">
                  <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" />
                </Field>
                <Field label="Campaign" hint="Groups posts in reports">
                  <Input value={campaign} onChange={(e) => setCampaign(e.target.value)} />
                </Field>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Attachments"
              subtitle="Images and video are re-hosted and served from the media store"
              icon={ImageIcon}
              actions={
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    hidden
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                      e.target.value = "";
                    }}
                  />
                  <Button size="sm" icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>
                    Upload
                  </Button>
                  <Button size="sm" variant="ghost" icon={Film} onClick={() => setPickerOpen(true)}>
                    Library
                  </Button>
                </>
              }
            />
            <CardBody>
              {attached.length ? (
                <ul className="flex flex-col gap-2">
                  {attached.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 rounded-[7px] border border-line bg-raised px-3 py-2">
                      <span className="grid h-8 w-8 place-items-center rounded-md border border-line bg-canvas text-ink-faint">
                        {m.mime.startsWith("video/") ? <Film size={14} /> : <ImageIcon size={14} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] text-ink-dim">{m.filename}</p>
                        <p className="tnum text-[11px] text-ink-faint">
                          {m.width && m.height ? `${m.width}x${m.height} - ` : ""}
                          {fmtBytes(m.bytes)}
                          {m.durationS ? ` - ${fmtDuration(m.durationS)}` : ""}
                        </p>
                      </div>
                      <IconButton icon={X} label="Remove attachment" onClick={() => setMediaIds((prev) => prev.filter((id) => id !== m.id))} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-faint">
                  No attachments. Text-only posts are valid for every network that supports them.
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Targets" subtitle={`${selected.length} selected`} icon={Send} />
            <CardBody className="flex flex-col gap-2">
              {accounts.length ? (
                accounts.map((a) => {
                  const on = accountIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      onClick={() => setAccountIds((prev) => (on ? prev.filter((id) => id !== a.id) : [...prev, a.id]))}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[7px] border px-2.5 py-2 text-left transition-colors",
                        on ? "border-accent/50 bg-accent-soft" : "border-line bg-raised hover:border-line-strong",
                      )}
                    >
                      <PlatformIcon platform={a.platform} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink-dim">{a.handle ?? a.display_name}</span>
                        <span className="block text-[10.5px] text-ink-faint">{platformLabel(a.platform)}</span>
                      </span>
                      {a.status !== "connected" ? <Badge tone={statusTone(a.status)}>{a.status}</Badge> : null}
                      {on ? <CheckCircle2 size={14} className="text-accent" /> : null}
                    </button>
                  );
                })
              ) : (
                <p className="text-[12px] text-ink-faint">No accounts yet. Connect one under Accounts.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Delivery" subtitle="Timing and post type" icon={CalendarClock} />
            <CardBody className="flex flex-col gap-3.5">
              <Field label="Post type">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {["text", "image", "video", "reel", "short", "story"].map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Scheduled for" hint="Leave empty to queue immediately">
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </Field>
              <Switch
                checked={saveAsDraft}
                onChange={setSaveAsDraft}
                label="Keep as draft"
                hint="Store without queueing. Useful for review before publication."
              />
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  variant="outline"
                  icon={Link2}
                  onClick={() => {
                    setScheduledAt("");
                    void submit(saveAsDraft);
                  }}
                >
                  {saveAsDraft ? "Save draft" : "Queue now"}
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Preflight" subtitle="Checks applied before the queue accepts the job" icon={CheckCircle2} />
            <CardBody>
              <ul className="flex flex-col gap-2 text-[12px]">
                {[
                  { ok: accountIds.length > 0, label: "At least one target account" },
                  { ok: Boolean(body.trim() || mediaIds.length), label: "Content or media present" },
                  { ok: !overLimit, label: `Within ${limits} character limit` },
                  { ok: !attached.some((m) => m.mime.startsWith("video/")) || ["video", "reel", "short", "story"].includes(kind), label: "Video post type matches the attachment" },
                ].map((row) => (
                  <li key={row.label} className="flex items-center gap-2">
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                        row.ok ? "border-good/40 bg-good-soft text-good" : "border-line-strong bg-raised text-ink-faint",
                      )}
                    >
                      {row.ok ? <CheckCircle2 size={10} /> : <X size={10} />}
                    </span>
                    <span className={row.ok ? "text-ink-dim" : "text-ink-faint"}>{row.label}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Media library"
        description="Select assets to attach. Multiple images become a carousel where the platform supports it."
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMediaIds([])}>
              Clear selection
            </Button>
            <Button variant="primary" onClick={() => setPickerOpen(false)}>
              Done ({mediaIds.length})
            </Button>
          </>
        }
      >
        <Grid cols={4}>
          {mediaRows.map((m) => {
            const on = mediaIds.includes(m.id);
            return (
              <button
                key={m.id}
                onClick={() => setMediaIds((prev) => (on ? prev.filter((id) => id !== m.id) : [...prev, m.id]))}
                className={cn(
                  "rounded-[7px] border p-2 text-left transition-colors",
                  on ? "border-accent/50 bg-accent-soft" : "border-line bg-raised hover:border-line-strong",
                )}
              >
                <div className="mb-2 grid h-20 place-items-center rounded-md border border-line bg-canvas text-ink-faint">
                  {m.mime.startsWith("video/") ? <Film size={16} /> : <ImageIcon size={16} />}
                </div>
                <p className="truncate text-[11.5px] text-ink-dim">{m.filename}</p>
                <p className="tnum text-[10.5px] text-ink-faint">
                  {fmtBytes(m.bytes)}
                  {m.durationS ? ` - ${fmtDuration(m.durationS)}` : ""}
                </p>
              </button>
            );
          })}
        </Grid>
        {!mediaRows.length ? (
          <p className="py-6 text-center text-[12px] text-ink-faint">The media library is empty. Upload an asset first.</p>
        ) : null}
      </Modal>
    </>
  );
}
