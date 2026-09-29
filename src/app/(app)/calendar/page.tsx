"use client";

import React, { useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  RotateCcw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmButton,
  EmptyState,
  IconButton,
  PageHeader,
  Select,
  Skeleton,
  Table,
  Td,
  Th,
  Tr,
  statusTone,
  cn,
} from "@/components/ui";
import { PlatformIcon, platformLabel } from "@/components/platforms";
import { api, fmtDateTime, fmtRelative, useApi, useToast } from "@/lib/client";

interface Post {
  id: string;
  status: string;
  kind: string;
  body: string;
  title: string | null;
  scheduled_at: string | null;
  updated_at: string;
  attempts: number;
  last_error: string | null;
  permalink: string | null;
  campaign: string | null;
  platform: string;
  handle: string | null;
  media: { mediaId: string }[];
}

interface Counts {
  draft: number;
  scheduled: number;
  queued: number;
  publishing: number;
  published: number;
  failed: number;
  cancelled: number;
}

const monthLabel = (d: Date) => d.toLocaleString(undefined, { month: "long", year: "numeric" });
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function CalendarPage() {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [cursor, setCursor] = useState(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (platform) p.set("platform", platform);
    p.set("limit", "200");
    return p.toString();
  }, [status, platform]);

  const { data, loading, reload } = useApi<{ posts: Post[]; counts: Counts }>(`/api/posts?${qs}`, [qs]);

  const act = async (id: string, action: string) => {
    setBusy(id);
    try {
      await api.post(`/api/posts/${id}`, { action });
      toast.push("good", `Post ${action} request sent.`);
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // week starts Monday
    const cells: { date: Date; inMonth: boolean; posts: Post[] }[] = [];
    const byDay = new Map<string, Post[]>();
    for (const p of data?.posts ?? []) {
      const when = p.scheduled_at ?? p.updated_at;
      if (!when) continue;
      const d = new Date(when.includes("T") ? when : when.replace(" ", "T") + "Z");
      if (Number.isNaN(d.getTime())) continue;
      const key = dayKey(d);
      byDay.set(key, [...(byDay.get(key) ?? []), p]);
    }
    for (let i = 0; i < 42; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      cells.push({ date, inMonth: date.getMonth() === cursor.getMonth(), posts: byDay.get(dayKey(date)) ?? [] });
    }
    return cells;
  }, [cursor, data]);

  const counts = data?.counts;

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Every draft, scheduled and in-flight post in one timeline. Scheduling is idempotent per post, so a restart cannot double-publish."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={11} /> {counts?.scheduled ?? 0} scheduled, {counts?.queued ?? 0} queued
            </span>
            <span className={cn("inline-flex items-center gap-1.5", (counts?.failed ?? 0) > 0 && "text-bad")}>
              <XCircle size={11} /> {counts?.failed ?? 0} failed
            </span>
          </>
        }
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-[140px]">
              <option value="">All states</option>
              {["draft", "scheduled", "queued", "publishing", "published", "failed", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-[150px]">
              <option value="">All platforms</option>
              {["facebook", "instagram", "tiktok", "youtube", "x", "threads", "linkedin", "pinterest", "mastodon"].map((p) => (
                <option key={p} value={p}>
                  {platformLabel(p)}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <Card className="mb-3">
        <CardHeader
          title={monthLabel(cursor)}
          subtitle="Publication timeline by scheduled time"
          icon={CalendarClock}
          actions={
            <>
              <IconButton
                icon={ChevronLeft}
                label="Previous month"
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
              />
              <Button size="sm" variant="ghost" onClick={() => setCursor(new Date())}>
                Today
              </Button>
              <IconButton
                icon={ChevronRight}
                label="Next month"
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
              />
            </>
          }
        />
        <CardBody className="p-0">
          <div className="grid grid-cols-7 border-b border-line text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="px-2 py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((cell) => {
              const isToday = dayKey(cell.date) === dayKey(new Date());
              return (
                <div
                  key={cell.date.toISOString()}
                  className={cn(
                    "min-h-[92px] border-b border-r border-line px-1.5 py-1.5",
                    !cell.inMonth && "bg-canvas/40",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={cn(
                        "tnum text-[11px]",
                        isToday ? "rounded bg-accent px-1.5 font-semibold text-white" : "text-ink-faint",
                      )}
                    >
                      {cell.date.getDate()}
                    </span>
                    {cell.posts.length > 2 ? (
                      <span className="tnum text-[10px] text-ink-faint">+{cell.posts.length - 2}</span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1">
                    {cell.posts.slice(0, 2).map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center gap-1.5 rounded border border-line bg-raised px-1.5 py-1"
                        title={`${p.body.slice(0, 80)}`}
                      >
                        <PlatformIcon platform={p.platform} size={9} />
                        <span className="truncate text-[10.5px] text-ink-mute">{p.body.slice(0, 22) || p.kind}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Queue detail"
          subtitle={`${data?.posts.length ?? 0} posts in the current filter`}
          icon={Send}
        />
        {loading && !data ? (
          <CardBody>
            <Skeleton className="h-40" />
          </CardBody>
        ) : data?.posts.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>State</Th>
                <Th>Post</Th>
                <Th>Scheduled</Th>
                <Th align="right">Attempts</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.posts.map((p) => (
                <Tr key={p.id}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <PlatformIcon platform={p.platform} />
                      <span className="truncate">{p.handle ?? "unassigned"}</span>
                    </span>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                      {p.campaign ? <span className="text-[10.5px] text-ink-faint">{p.campaign}</span> : null}
                    </div>
                  </Td>
                  <Td className="max-w-[340px]">
                    <span className="line-clamp-2 text-ink-dim">{p.body || `(${p.kind} with media)`}</span>
                    {p.last_error ? (
                      <span className="mt-1 block truncate font-mono text-[10.5px] text-bad">{p.last_error}</span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-faint">
                    {p.scheduled_at ? (
                      <span title={fmtDateTime(p.scheduled_at)}>{fmtRelative(p.scheduled_at)}</span>
                    ) : (
                      fmtRelative(p.updated_at)
                    )}
                  </Td>
                  <Td align="right">{p.attempts}</Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      {p.permalink ? (
                        <a href={p.permalink} target="_blank" rel="noreferrer">
                          <IconButton icon={ExternalLink} label="Open published post" />
                        </a>
                      ) : null}
                      {["draft", "scheduled", "queued"].includes(p.status) ? (
                        <Button size="sm" variant="ghost" icon={Send} loading={busy === p.id} onClick={() => act(p.id, "publish")}>
                          Publish
                        </Button>
                      ) : null}
                      {["failed", "cancelled"].includes(p.status) ? (
                        <Button size="sm" variant="ghost" icon={RotateCcw} loading={busy === p.id} onClick={() => act(p.id, "retry")}>
                          Retry
                        </Button>
                      ) : null}
                      {["draft", "scheduled", "queued"].includes(p.status) ? (
                        <ConfirmButton
                          label="Cancel"
                          confirmLabel="Confirm cancel"
                          icon={XCircle}
                          variant="ghost"
                          onConfirm={() => act(p.id, "cancel")}
                        />
                      ) : null}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="Nothing in this filter"
            description="Adjust the state or platform filter, or compose a new post."
          />
        )}
      </Card>
    </>
  );
}
