"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ExternalLink,
  Filter,
  Inbox,
  MessagesSquare,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  ThumbsDown,
  Wand2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  IconButton,
  PageHeader,
  Select,
  Skeleton,
  StatTile,
  Textarea,
  Grid,
  statusTone,
  cn,
} from "@/components/ui";
import { AreaChart, RankBars } from "@/components/charts";
import { PlatformIcon, platformColor, platformLabel } from "@/components/platforms";
import { api, fmtDateTime, fmtNumber, fmtRelative, sentimentLabel, useApi, useToast } from "@/lib/client";

interface Reply {
  id: string;
  mode: string;
  body: string;
  status: string;
  model: string | null;
  confidence: number | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  external_id: string | null;
}

interface Comment {
  id: string;
  account_id: string;
  platform: string;
  author_handle: string | null;
  author_name: string | null;
  body: string;
  sentiment: number | null;
  intent: string | null;
  language: string | null;
  risk: string;
  received_at: string;
  thread_kind: string;
  replies: Reply[];
}

interface Payload {
  comments: Comment[];
  counts: { pending: number; sent: number; blocked: number; failed: number };
  stats: {
    sentiment7d: number | null;
    inbound7d: number;
    byRisk: { risk: string; count: number }[];
    byIntent: { intent: string | null; count: number }[];
    trend: { day: string; inbound: number; sentiment: number | null; crisis: number }[];
  };
}

const RISK_TONE: Record<string, "good" | "warn" | "bad" | "muted" | "neutral"> = {
  none: "muted",
  sensitive: "warn",
  crisis: "bad",
  spam: "muted",
};

export default function InboxPage() {
  const toast = useToast();
  const [risk, setRisk] = useState("");
  const [platform, setPlatform] = useState("");
  const [replyFilter, setReplyFilter] = useState("");
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (risk) p.set("risk", risk);
    if (platform) p.set("platform", platform);
    if (replyFilter) p.set("hasReply", replyFilter);
    return p.toString();
  }, [risk, platform, replyFilter]);

  const { data, loading, reload } = useApi<Payload>(`/api/comments?${qs}`, [qs]);

  const act = async (replyId: string, action: string, body?: string, reason?: string) => {
    setBusy(replyId);
    try {
      const res = await api.post<{ ok?: boolean; simulated?: boolean; error?: string }>(`/api/replies/${replyId}`, {
        action,
        body,
        reason,
      });
      if (action === "approve" && res && res.ok === false) {
        toast.push("bad", res.error ?? "Reply send failed.");
      } else {
        toast.push("good", action === "approve" ? "Reply sent." : action === "reject" ? "Reply rejected and recorded as a negative example." : "Reply updated.");
      }
      setEditing((prev) => ({ ...prev, [replyId]: "" }));
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  const syncAll = async () => {
    setBusy("sync");
    try {
      const accounts = await api.get<{ accounts: { id: string }[] }>("/api/accounts");
      const results = await Promise.all(
        accounts.accounts.map((a) => api.post<{ ingested: number }>("/api/dashboard", { action: "sync", accountId: a.id }).catch(() => null)),
      );
      const ingested = results.reduce((acc, r) => acc + (r?.ingested ?? 0), 0);
      toast.push("good", `Sync complete: ${ingested} new message(s) ingested.`);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const stats = data?.stats;

  return (
    <>
      <PageHeader
        title="Engagement"
        description="Inbound comments, mentions and messages with the AI drafting lane. Policy gates run before the model ever sees the message."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Bot size={11} /> {fmtNumber(data?.counts.pending)} awaiting approval
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert size={11} /> {fmtNumber(data?.counts.blocked)} blocked by policy
            </span>
          </>
        }
        actions={
          <Button icon={RefreshCw} loading={busy === "sync"} onClick={syncAll}>
            Sync all accounts
          </Button>
        }
      />

      <Grid cols={4} className="mb-3">
        <StatTile label="Inbound 7d" value={fmtNumber(stats?.inbound7d)} hint="messages received" icon={MessagesSquare} />
        <StatTile
          label="Average sentiment"
          value={stats?.sentiment7d === null || stats?.sentiment7d === undefined ? "-" : Number(stats.sentiment7d).toFixed(2)}
          tone={(stats?.sentiment7d ?? 0) >= 0.15 ? "good" : (stats?.sentiment7d ?? 0) <= -0.2 ? "bad" : "warn"}
          hint={sentimentLabel(stats?.sentiment7d)}
          icon={Sparkles}
        />
        <StatTile label="Replies sent 7d" value={fmtNumber(data?.counts.sent)} hint="auto and approved" icon={Send} />
        <StatTile
          label="Blocked"
          value={fmtNumber(data?.counts.blocked)}
          tone={(data?.counts.blocked ?? 0) > 0 ? "warn" : "good"}
          hint="escalated to a human"
          icon={ShieldAlert}
        />
      </Grid>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Inbound volume and sentiment" subtitle="Daily message count with average polarity" icon={MessagesSquare} />
          <CardBody>
            <AreaChart
              series={(stats?.trend ?? []).map((t) => ({ x: t.day, y: t.inbound }))}
              label="Messages per day"
              height={140}
            />
            <div className="mt-3 border-t border-line pt-3">
              <AreaChart
                series={(stats?.trend ?? []).map((t) => ({ x: t.day, y: Number(t.sentiment ?? 0) }))}
                label="Average sentiment"
                format={(v) => v.toFixed(2)}
                height={120}
                color="var(--color-good)"
              />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Intent mix" subtitle="Classified automatically on arrival" icon={Filter} />
          <CardBody>
            <RankBars
              data={(stats?.byIntent ?? []).map((i) => ({
                label: i.intent ?? "unclassified",
                value: i.count,
                tone: i.intent === "complaint" ? "var(--color-warn)" : i.intent === "spam" ? "var(--color-bad)" : "var(--color-accent)",
              }))}
              format={(v) => fmtNumber(v)}
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Inbound messages"
          subtitle="Newest first. Drafts are generated by the configured AI provider and gated by the reply rules."
          icon={Inbox}
          actions={
            <>
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-[140px]">
                <option value="">All platforms</option>
                {["facebook", "instagram", "tiktok", "youtube", "x", "threads", "linkedin"].map((p) => (
                  <option key={p} value={p}>
                    {platformLabel(p)}
                  </option>
                ))}
              </Select>
              <Select value={risk} onChange={(e) => setRisk(e.target.value)} className="w-[130px]">
                <option value="">Any risk</option>
                {["none", "sensitive", "crisis", "spam"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
              <Select value={replyFilter} onChange={(e) => setReplyFilter(e.target.value)} className="w-[150px]">
                <option value="">Any reply state</option>
                <option value="pending">Has pending draft</option>
                <option value="none">No reply yet</option>
              </Select>
            </>
          }
        />

        {loading && !data ? (
          <CardBody>
            <Skeleton className="h-48" />
          </CardBody>
        ) : data?.comments.length ? (
          <ul className="divide-y divide-line">
            {data.comments.map((c) => {
              const pending = c.replies.find((r) => r.status === "pending");
              const sent = c.replies.find((r) => r.status === "sent");
              const blocked = c.replies.find((r) => r.status === "blocked" || r.status === "failed" || r.status === "rejected");
              const draftValue = editing[pending?.id ?? ""] ?? pending?.body ?? "";

              return (
                <li key={c.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-start gap-3">
                    <PlatformIcon platform={c.platform} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12.5px] font-medium text-ink-dim">
                          {c.author_name ?? c.author_handle ?? "unknown"}
                        </span>
                        <Badge tone={RISK_TONE[c.risk] ?? "neutral"}>{c.risk === "none" ? "low risk" : c.risk}</Badge>
                        {c.intent ? <Badge tone="neutral">{c.intent}</Badge> : null}
                        {c.sentiment !== null ? (
                          <span className="tnum text-[11px] text-ink-faint" title={`sentiment ${c.sentiment}`}>
                            {Number(c.sentiment).toFixed(2)}
                          </span>
                        ) : null}
                        <span className="text-[11px] text-ink-faint">{platformLabel(c.platform)}</span>
                        <span className="text-[11px] text-ink-faint">{fmtRelative(c.received_at)}</span>
                      </div>
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink">{c.body}</p>

                      {pending ? (
                        <div className="mt-3 rounded-[7px] border border-line bg-raised p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge tone="warn" dot>
                              draft awaiting approval
                            </Badge>
                            {pending.model ? <Badge tone="muted" mono>{pending.model}</Badge> : null}
                            {pending.confidence ? (
                              <span className="tnum text-[11px] text-ink-faint">confidence {pending.confidence.toFixed(2)}</span>
                            ) : null}
                          </div>
                          <Textarea
                            rows={3}
                            value={draftValue}
                            onChange={(e) => setEditing((prev) => ({ ...prev, [pending.id]: e.target.value }))}
                          />
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              icon={Check}
                              loading={busy === pending.id}
                              onClick={() => act(pending.id, "approve", draftValue)}
                            >
                              Approve and send
                            </Button>
                            <Button
                              size="sm"
                              icon={Wand2}
                              loading={busy === pending.id}
                              onClick={() => act(pending.id, "regenerate")}
                            >
                              Regenerate
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={ThumbsDown}
                              loading={busy === pending.id}
                              onClick={() => act(pending.id, "reject", undefined, "rejected in review")}
                            >
                              Reject
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {sent ? (
                        <div className="mt-3 rounded-[7px] border border-good/25 bg-good-soft/60 p-3">
                          <div className="mb-1.5 flex items-center gap-2">
                            <Badge tone="good" dot>
                              reply sent
                            </Badge>
                            <span className="text-[11px] text-ink-faint">
                              {sent.mode} - {sent.sent_at ? fmtDateTime(sent.sent_at) : ""}
                            </span>
                          </div>
                          <p className="text-[12px] leading-relaxed text-ink-dim">{sent.body}</p>
                        </div>
                      ) : null}

                      {!pending && !sent && blocked ? (
                        <div className="mt-3 rounded-[7px] border border-line bg-raised p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={blocked.status === "failed" ? "bad" : "muted"}>
                              <ShieldAlert size={11} /> {blocked.status}
                            </Badge>
                            {blocked.error ? (
                              <span className="font-mono text-[11px] text-ink-mute">{blocked.error}</span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {!pending && !sent && !blocked ? (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={Sparkles}
                            loading={busy === c.id}
                            onClick={async () => {
                              setBusy(c.id);
                              try {
                                await api.post(`/api/comments/${c.id}/draft`);
                                toast.push("good", "Draft generated and queued for approval.");
                                await reload();
                              } catch (err) {
                                toast.push("bad", (err as { message?: string }).message ?? "Draft failed.");
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            Draft reply
                          </Button>
                          <span className="text-[11px] text-ink-faint">
                            No draft yet. The reply worker drafts automatically when a matching rule is enabled.
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={Inbox}
            title="No messages in this filter"
            description="Sync an account or relax the filters to see inbound traffic."
          />
        )}
      </Card>
    </>
  );
}
