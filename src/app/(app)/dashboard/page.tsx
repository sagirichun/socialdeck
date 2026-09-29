"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  MessagesSquare,
  Radio,
  Share2,
  TrendingUp,
  Activity,
  Send,
  Gauge,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Grid,
  LiveDot,
  PageHeader,
  ProgressBar,
  Select,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  statusTone,
  cn,
} from "@/components/ui";
import { AreaChart, LineChart, RankBars } from "@/components/charts";
import { PlatformIcon, platformColor, platformLabel } from "@/components/platforms";
import { api, fmtCompact, fmtNumber, fmtRelative, sentimentLabel, useApi } from "@/lib/client";

interface DashboardPayload {
  days: number;
  totals: {
    accounts: number;
    connected: number;
    published: number;
    queued: number;
    failed: number;
    inbound: number;
    replies: number;
    pendingReplies: number;
    sentiment: number | null;
    liveStreams: number;
  };
  followerSeries: { day: string; followers: number; impressions: number; engagements: number; posts: number; inbound: number; replies: number }[];
  platformMix: { platform: string; accounts: number; engagements: number; followers: number }[];
  recentPosts: { id: string; status: string; kind: string; body: string; scheduled_at: string | null; updated_at: string; permalink: string | null; platform: string; handle: string | null }[];
  recentInbound: { id: string; platform: string; author_handle: string | null; body: string; risk: string; sentiment: number | null; received_at: string; reply_status: string | null }[];
  sentimentByDay: { day: string; sentiment: number; n: number }[];
  queueTrend: { day: string; completed: number; failed: number }[];
}

const RANGES = [7, 14, 30, 90];

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useApi<DashboardPayload>(`/api/dashboard?days=${days}`, [days]);
  const [syncing, setSyncing] = useState(false);

  const followerDelta = useMemo(() => {
    const s = data?.followerSeries ?? [];
    if (s.length < 2) return null;
    const first = s[0].followers || 0;
    const last = s[s.length - 1].followers || 0;
    if (!first) return null;
    return ((last - first) / first) * 100;
  }, [data]);

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Dashboard data unavailable"
        description={error.message}
        action={<Button icon={Activity} onClick={reload}>Retry</Button>}
      />
    );
  }

  const totals = data?.totals;

  return (
    <>
      <PageHeader
        title="Operations overview"
        description="Publishing throughput, engagement health and relay status across every connected account."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Clock size={11} /> window: last {days} days
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Share2 size={11} /> {totals?.connected ?? 0} of {totals?.accounts ?? 0} accounts connected
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Gauge size={11} /> generated {fmtRelative(new Date().toISOString())}
            </span>
          </>
        }
        actions={
          <>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-[132px]">
              {RANGES.map((r) => (
                <option key={r} value={r}>
                  Last {r} days
                </option>
              ))}
            </Select>
            <Button
              icon={Send}
              loading={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  const accounts = await api.get<{ accounts: { id: string }[] }>("/api/accounts");
                  await Promise.all(
                    accounts.accounts.slice(0, 6).map((a) =>
                      api.post("/api/dashboard", { action: "sync", accountId: a.id }).catch(() => null),
                    ),
                  );
                  await reload();
                } finally {
                  setSyncing(false);
                }
              }}
            >
              Sync inbox
            </Button>
          </>
        }
      />

      {loading && !data ? (
        <Grid cols={4}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px]" />
          ))}
        </Grid>
      ) : (
        <>
          <Grid cols={4}>
            <StatTile
              label="Published"
              value={fmtNumber(totals?.published)}
              delta={followerDelta}
              hint={`in the last ${days} days`}
              icon={CheckCircle2}
              footer={
                <div className="flex items-center justify-between text-[11px] text-ink-faint">
                  <span>Failed publishes</span>
                  <span className={cn("tnum", (totals?.failed ?? 0) > 0 && "text-bad")}>{totals?.failed ?? 0}</span>
                </div>
              }
            />
            <StatTile
              label="Queued ahead"
              value={fmtNumber(totals?.queued)}
              hint="scheduled and in-flight"
              icon={CalendarClock}
              tone={(totals?.queued ?? 0) > 0 ? "info" : "neutral"}
            />
            <StatTile
              label="Inbound messages"
              value={fmtCompact(totals?.inbound)}
              hint="comments, mentions, replies"
              icon={MessagesSquare}
            />
            <StatTile
              label="Replies awaiting review"
              value={fmtNumber(totals?.pendingReplies)}
              tone={(totals?.pendingReplies ?? 0) > 0 ? "warn" : "good"}
              hint={`${fmtNumber(totals?.replies)} drafted in window`}
              icon={MessagesSquare}
            />
            <StatTile
              label="Audience"
              value={fmtCompact(data?.followerSeries.at(-1)?.followers)}
              delta={followerDelta}
              hint="total across accounts"
              icon={TrendingUp}
            />
            <StatTile
              label="Engagements"
              value={fmtCompact(data?.followerSeries.reduce((acc, d) => acc + d.engagements, 0))}
              hint="likes, comments, shares"
              icon={Activity}
            />
            <StatTile
              label="Sentiment"
              value={totals?.sentiment === null || totals?.sentiment === undefined ? "-" : Number(totals.sentiment).toFixed(2)}
              tone={(totals?.sentiment ?? 0) >= 0.15 ? "good" : (totals?.sentiment ?? 0) <= -0.2 ? "bad" : "warn"}
              hint={sentimentLabel(totals?.sentiment)}
              icon={Gauge}
            />
            <StatTile
              label="Live relays"
              value={fmtNumber(totals?.liveStreams)}
              tone={(totals?.liveStreams ?? 0) > 0 ? "good" : "muted"}
              icon={Radio}
              footer={
                (totals?.liveStreams ?? 0) > 0 ? (
                  <LiveDot label="Broadcasting now" />
                ) : (
                  <span className="text-[11px] text-ink-faint">No relay running</span>
                )
              }
            />
          </Grid>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Audience and engagement"
                subtitle="Rolling totals from the stored daily analytics"
                icon={TrendingUp}
                actions={<Badge tone="neutral">last {days} days</Badge>}
              />
              <CardBody>
                <LineChart
                  series={[
                    { name: "Followers", color: "var(--color-accent)", points: (data?.followerSeries ?? []).map((d) => ({ x: d.day, y: d.followers })) },
                    { name: "Engagements", color: "var(--color-good)", points: (data?.followerSeries ?? []).map((d) => ({ x: d.day, y: d.engagements })) },
                    { name: "Impressions", color: "var(--color-warn)", points: (data?.followerSeries ?? []).map((d) => ({ x: d.day, y: d.impressions })) },
                  ]}
                  format={(v) => fmtCompact(v)}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Platform mix" subtitle="Audience by network" icon={Share2} />
              <CardBody>
                {data?.platformMix.length ? (
                  <RankBars
                    data={data.platformMix.map((p) => ({
                      label: platformLabel(p.platform),
                      value: p.followers,
                      tone: platformColor(p.platform),
                    }))}
                    format={(v) => fmtCompact(v)}
                  />
                ) : (
                  <EmptyState title="No accounts connected" description="Connect a platform to populate the mix." />
                )}
              </CardBody>
            </Card>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Queue throughput"
                subtitle="Completed and failed jobs per day, from the SQL ledger"
                icon={Activity}
              />
              <CardBody>
                <LineChart
                  series={[
                    { name: "Completed", color: "var(--color-good)", points: (data?.queueTrend ?? []).map((d) => ({ x: d.day, y: d.completed })) },
                    { name: "Failed", color: "var(--color-bad)", points: (data?.queueTrend ?? []).map((d) => ({ x: d.day, y: d.failed })) },
                  ]}
                  height={150}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Sentiment trend" subtitle="Average polarity of inbound messages" icon={Gauge} />
              <CardBody>
                <AreaChart
                  series={(data?.sentimentByDay ?? []).map((d) => ({ x: d.day, y: Number(d.sentiment ?? 0) }))}
                  format={(v) => v.toFixed(2)}
                  height={150}
                />
                <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
                  {[
                    { label: "Positive", range: "0.35 to 1.00" },
                    { label: "Neutral", range: "-0.15 to 0.35" },
                    { label: "Negative", range: "-1.00 to -0.15" },
                  ].map((band) => (
                    <div key={band.label} className="flex items-center justify-between text-[11.5px]">
                      <span className="text-ink-mute">{band.label}</span>
                      <span className="tnum font-mono text-[11px] text-ink-faint">{band.range}</span>
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Recent publishing activity"
                subtitle="Latest state changes across the queue"
                icon={Send}
              />
              {data?.recentPosts.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>Account</Th>
                      <Th>Post</Th>
                      <Th>State</Th>
                      <Th align="right">When</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentPosts.map((p) => (
                      <Tr key={p.id}>
                        <Td>
                          <span className="flex items-center gap-2">
                            <PlatformIcon platform={p.platform} />
                            <span className="truncate">{p.handle ?? "unassigned"}</span>
                          </span>
                        </Td>
                        <Td className="max-w-[280px]">
                          <span className="line-clamp-1 text-ink-dim">{p.body || "(media only)"}</span>
                        </Td>
                        <Td>
                          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                        </Td>
                        <Td align="right" className="whitespace-nowrap text-ink-faint">
                          {fmtRelative(p.updated_at)}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState icon={CalendarClock} title="Nothing published yet" description="Compose a post to get started." />
              )}
            </Card>

            <Card>
              <CardHeader
                title="Inbound requiring attention"
                subtitle="Risk-ranked, newest first"
                icon={MessagesSquare}
              />
              {data?.recentInbound.length ? (
                <ul className="divide-y divide-line">
                  {data.recentInbound.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                      <PlatformIcon platform={c.platform} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium text-ink-dim">{c.author_handle ?? "unknown"}</span>
                          <Badge tone={statusTone(c.risk)}>{c.risk}</Badge>
                          {c.sentiment !== null ? (
                            <span className="tnum text-[11px] text-ink-faint">{Number(c.sentiment).toFixed(2)}</span>
                          ) : null}
                          {c.reply_status ? <Badge tone={statusTone(c.reply_status)}>{c.reply_status}</Badge> : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-mute">{c.body}</p>
                      </div>
                      <span className="whitespace-nowrap text-[11px] text-ink-faint">{fmtRelative(c.received_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={MessagesSquare} title="Inbox is clear" description="No inbound messages in the window." />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
