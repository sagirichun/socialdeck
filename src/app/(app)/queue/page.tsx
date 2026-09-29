"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ListChecks,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmButton,
  EmptyState,
  Grid,
  KeyValue,
  PageHeader,
  Select,
  Skeleton,
  StatTile,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
  statusTone,
} from "@/components/ui";
import { BarChart, Sparkline } from "@/components/charts";
import { api, fmtDateTime, fmtNumber, fmtRelative, useApi, useToast } from "@/lib/client";

interface Job {
  id: string;
  queue: string;
  job_name: string;
  ref_table: string | null;
  ref_id: string | null;
  state: string;
  attempts: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface QueueRow {
  queue: string;
  waiting: number;
  active: number;
  failed: number;
  completed: number;
  last_activity: string | null;
}

interface Payload {
  jobs: Job[];
  queues: QueueRow[];
  throughput: { hour: string; jobs: number }[];
  health: { ffmpeg: string | null; allowLive: boolean; running: { id: string; name: string; pid: number | null }[] };
}

const STATES = ["all", "queued", "delayed", "active", "completed", "failed"];

export default function QueuePage() {
  const toast = useToast();
  const [state, setState] = useState("all");
  const { data, loading, error, reload } = useApi<Payload>(`/api/queue?state=${state === "all" ? "" : state}&limit=80`, [state], { pollMs: 6000 });

  const stats = useMemo(() => {
    const rows = data?.queues ?? [];
    return {
      waiting: rows.reduce((a, q) => a + q.waiting, 0),
      active: rows.reduce((a, q) => a + q.active, 0),
      failed: rows.reduce((a, q) => a + q.failed, 0),
      completed: rows.reduce((a, q) => a + q.completed, 0),
    };
  }, [data]);

  const purge = async () => {
    try {
      await api.del("/api/queue");
      toast.push("good", "Finished jobs older than 7 days purged.");
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Purge failed.");
    }
  };

  const drop = async (job: Job) => {
    try {
      await api.del(`/api/queue?id=${job.id}`);
      toast.push("good", "Job record removed.");
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Remove failed.");
    }
  };

  if (error) {
    return <EmptyState icon={AlertTriangle} title="Queue unavailable" description={error.message} action={<Button icon={RefreshCw} onClick={reload}>Retry</Button>} />;
  }

  return (
    <>
      <PageHeader
        title="Job queue"
        description="Every publish, relay and automation job, with its ledger state and failure reason."
        meta={
          <span className="inline-flex items-center gap-1.5">
            <Server size={11} /> workers: inline / bullmq + redis
          </span>
        }
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={reload}>Refresh</Button>
            <ConfirmButton variant="ghost" icon={Trash2} title="Purge finished jobs" body="Remove completed and failed job records older than 7 days from the ledger." onConfirm={purge}>
              Purge old
            </ConfirmButton>
          </>
        }
      />

      <Grid cols={4}>
        <StatTile label="Waiting" value={fmtNumber(stats.waiting)} icon={Clock} tone={stats.waiting ? "warn" : "neutral"} hint="queued and delayed" />
        <StatTile label="Active" value={fmtNumber(stats.active)} icon={Zap} tone={stats.active ? "info" : "neutral"} hint="in-flight right now" />
        <StatTile label="Completed" value={fmtNumber(stats.completed)} icon={CheckCircle2} tone="good" hint="all time" />
        <StatTile label="Failed" value={fmtNumber(stats.failed)} icon={XCircle} tone={stats.failed ? "bad" : "neutral"} hint="needs inspection" />
      </Grid>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Throughput" subtitle="Jobs enqueued per hour over the last 24 hours" icon={Zap} />
          <CardBody>
            <BarChart
              data={(data?.throughput ?? []).map((t) => ({ label: `${t.hour}:00`, value: t.jobs }))}
              format={(v) => fmtNumber(v)}
              height={150}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Runtime" subtitle="ffmpeg and live relay processes" icon={Server} />
          <CardBody>
            <KeyValue
              rows={[
                { label: "ffmpeg", value: data?.health.ffmpeg ?? "not detected", mono: Boolean(data?.health.ffmpeg) },
                { label: "Live outbound", value: data?.health.allowLive ? "enabled" : "sandbox (no live writes)" },
                { label: "Relay processes", value: String(data?.health.running.length ?? 0) },
              ]}
            />
            {data?.health.running.length ? (
              <ul className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
                {data.health.running.map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-[11.5px]">
                    <span className="truncate text-ink-dim">{s.name}</span>
                    <span className="tnum font-mono text-ink-faint">pid {s.pid ?? "-"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {!data?.health.ffmpeg ? (
              <p className="mt-3 border-t border-line pt-3 text-[11.5px] leading-relaxed text-ink-faint">
                ffmpeg is missing from PATH. Video variants and RTMP relays will fail until it is installed.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-3">
        <CardHeader
          title="Job ledger"
          subtitle="Newest first, across all queues"
          icon={ListChecks}
          actions={
            <div className="w-[160px]">
              <Select value={state} onChange={(e) => setState(e.target.value)}>
                {STATES.map((s) => <option key={s} value={s}>{s === "all" ? "All states" : s}</option>)}
              </Select>
            </div>
          }
        />
        {loading && !data ? (
          <CardBody><Skeleton className="h-[220px]" /></CardBody>
        ) : data?.jobs.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Queue</Th>
                <Th>Reference</Th>
                <Th>State</Th>
                <Th>Attempts</Th>
                <Th align="right">When</Th>
                <Th align="right" width={60}></Th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <Tr key={job.id}>
                  <Td>
                    <span className="font-mono text-[11.5px]">{job.job_name}</span>
                    {job.error ? <div className="mt-0.5 max-w-[280px] truncate text-[10.5px] text-bad" title={job.error}>{job.error}</div> : null}
                  </Td>
                  <Td><Badge tone="neutral">{job.queue}</Badge></Td>
                  <Td className="text-[11.5px] text-ink-faint">{job.ref_table ? `${job.ref_table}/${job.ref_id ?? "-"}` : "-"}</Td>
                  <Td><Badge tone={statusTone(job.state)}>{job.state}</Badge></Td>
                  <Td className="tnum">{job.attempts}</Td>
                  <Td align="right" className="whitespace-nowrap text-ink-faint">{fmtRelative(job.created_at)}</Td>
                  <Td align="right">
                    <Button size="xs" variant="ghost" icon={Trash2} onClick={() => drop(job)} className="text-ink-faint hover:text-bad" />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={ListChecks} title="No jobs in the ledger" description="Scheduled posts and running relays will appear here." />
        )}
      </Card>

      <Card className="mt-3">
        <CardHeader title="Queue split" subtitle="Per queue backlog and last activity" icon={Server} />
        <CardBody>
          {data?.queues.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Queue</Th>
                  <Th align="right">Waiting</Th>
                  <Th align="right">Active</Th>
                  <Th align="right">Completed</Th>
                  <Th align="right">Failed</Th>
                  <Th align="right">Last activity</Th>
                </tr>
              </thead>
              <tbody>
                {data.queues.map((q) => (
                  <Tr key={q.queue}>
                    <Td><Badge tone="neutral">{q.queue}</Badge></Td>
                    <Td align="right" className="tnum">{q.waiting}</Td>
                    <Td align="right" className="tnum">{q.active}</Td>
                    <Td align="right" className="tnum">{q.completed}</Td>
                    <Td align="right" className={q.failed ? "tnum text-bad" : "tnum"}>{q.failed}</Td>
                    <Td align="right" className="text-ink-faint">{q.last_activity ? fmtDateTime(q.last_activity) : "-"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No queue activity" description="Queues populate once jobs are enqueued." />
          )}
        </CardBody>
      </Card>
    </>
  );
}
