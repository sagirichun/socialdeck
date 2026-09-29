"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  Play,
  ShieldAlert,
  Sparkles,
  Terminal,
  Wand2,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Grid,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatTile,
  Textarea,
  cn,
} from "@/components/ui";
import { api, fmtDateTime, fmtRelative, useApi, useToast } from "@/lib/client";

interface Step {
  id: string;
  step_no: number;
  thought: string | null;
  tool: string | null;
  args: unknown;
  result: unknown;
  status: string;
  error: string | null;
  created_at: string;
}

interface Run {
  id: string;
  goal: string;
  status: string;
  plan: string | null;
  summary: string | null;
  error: string | null;
  steps_used: number;
  max_steps: number;
  created_at: string;
  finished_at: string | null;
  steps?: Step[];
}

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  done: CheckCircle2,
  running: Loader2,
  failed: XCircle,
  denied: ShieldAlert,
  pending: Circle,
};

const SUGGESTIONS = [
  "Draft three LinkedIn posts about our new compliance module and schedule them for next week at 09:00 local time",
  "Summarise inbound sentiment for the last 24 hours and flag anything that needs a human",
  "Check every connected account for expiring tokens and tell me which ones need attention",
  "Write a caption for the product launch video and add it to the media library description",
  "Audit the queue for posts that failed more than twice and retry the ones that look transient",
];

export default function AgentPage() {
  const toast = useToast();
  const [goal, setGoal] = useState("");
  const [autonomy, setAutonomy] = useState("supervised");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, loading, reload } = useApi<{ runs: Run[]; catalog: { name: string; description: string; writes: boolean; capability: string }[]; autonomy: string[]; maxSteps: number }>(
    "/api/agent",
    [],
    { pollMs: 4000 },
  );

  const { data: detail, reload: reloadDetail } = useApi<{ run: Run }>(selected ? `/api/agent?runId=${selected}` : null, [selected], {
    pollMs: 3000,
  });

  useEffect(() => {
    if (detail?.run.status === "done" || detail?.run.status === "failed") {
      if (poll.current) clearInterval(poll.current);
    }
  }, [detail?.run.status]);

  const launch = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ runId: string; status: string }>("/api/agent", { goal, autonomy });
      toast.push("good", "Run accepted. The agent plans, calls tools and reports back.");
      setSelected(res.runId);
      setGoal("");
      await reload();
      await reloadDetail();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not start the run");
    } finally {
      setBusy(false);
    }
  };

  const runs = data?.runs ?? [];

  return (
    <>
      <PageHeader
        title="Operations agent"
        description="A plan-act-observe loop over the same tools the console uses. Tool calls are permission-gated, every step is journaled, and destructive actions always require the owner role."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Terminal size={11} /> {data?.catalog.length ?? 0} tools available
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={11} /> max {data?.maxSteps ?? 0} steps per run
            </span>
          </>
        }
      />

      <Grid cols={3} className="mb-3">
        <StatTile label="Runs recorded" value={runs.length} hint="most recent first" icon={Bot} />
        <StatTile
          label="Completed"
          value={runs.filter((r) => r.status === "done").length}
          tone="good"
          hint="finished without error"
          icon={CheckCircle2}
        />
        <StatTile
          label="Failed or denied"
          value={runs.filter((r) => r.status === "failed" || r.status === "denied").length}
          tone={runs.some((r) => r.status === "failed" || r.status === "denied") ? "warn" : "muted"}
          hint="guardrails engaged"
          icon={ShieldAlert}
        />
      </Grid>

      <Card className="mb-3">
        <CardHeader title="New run" subtitle="State the outcome, not the steps. The agent selects tools itself." icon={Wand2} />
        <CardBody>
          <div className="flex flex-col gap-3">
            <Textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Pause every channel scheduled for the holiday weekend and reschedule them to Tuesday 09:00"
            />
            <div className="flex flex-wrap items-center gap-2.5">
              <Select value={autonomy} onChange={(e) => setAutonomy(e.target.value)} className="w-[190px]">
                {(data?.autonomy ?? ["supervised", "autonomous"]).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
              <Button variant="primary" icon={Play} loading={busy} onClick={launch}>
                Run goal
              </Button>
              <span className="text-[11px] text-ink-faint">
                Supervised mode stops before any write tool and waits for approval. Autonomous mode executes writes within the tool allowlist.
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setGoal(s)}
                  className="rounded-full border border-line bg-raised px-2.5 py-1 text-[11px] text-ink-mute transition-colors hover:border-line-strong hover:text-ink-dim"
                >
                  {s.length > 58 ? s.slice(0, 56) + "..." : s}
                </button>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Run history" subtitle="Click a run to inspect its trace" icon={Bot} />
          {loading && !data ? (
            <CardBody>
              <Skeleton className="h-40" />
            </CardBody>
          ) : runs.length ? (
            <ul className="divide-y divide-line">
              {runs.map((r) => {
                const Icon = STATUS_ICON[r.status] ?? Circle;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelected(r.id)}
                      className={cn(
                        "flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors",
                        selected === r.id ? "bg-accent-soft/60" : "hover:bg-raised",
                      )}
                    >
                      <Icon
                        size={13}
                        className={cn(
                          "mt-0.5 shrink-0",
                          r.status === "done" ? "text-good" : r.status === "failed" || r.status === "denied" ? "text-bad" : "text-warn",
                          r.status === "running" && "animate-spin",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-ink-dim">{r.goal}</span>
                        <span className="mt-1 block text-[10.5px] text-ink-faint">
                          {r.status} - {r.steps_used}/{r.max_steps} steps - {fmtRelative(r.created_at)}
                        </span>
                      </span>
                      <ChevronRight size={13} className="mt-1 shrink-0 text-ink-faint" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={Bot} title="No runs yet" description="State a goal above to start the first one." />
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Trace"
            subtitle={detail?.run ? `${detail.run.status} - ${detail.run.steps_used}/${detail.run.max_steps} steps` : "Select a run"}
            icon={Terminal}
          />
          <CardBody>
            {detail?.run ? (
              <div className="flex flex-col gap-3">
                <div className="rounded-[7px] border border-line bg-raised p-3">
                  <p className="text-[11px] uppercase tracking-[0.06em] text-ink-faint">Goal</p>
                  <p className="mt-1 text-[12.5px] text-ink-dim">{detail.run.goal}</p>
                  {detail.run.plan ? (
                    <>
                      <p className="mt-2.5 text-[11px] uppercase tracking-[0.06em] text-ink-faint">Plan</p>
                      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-mute">{detail.run.plan}</p>
                    </>
                  ) : null}
                  {detail.run.summary ? (
                    <>
                      <p className="mt-2.5 text-[11px] uppercase tracking-[0.06em] text-ink-faint">Outcome</p>
                      <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-dim">{detail.run.summary}</p>
                    </>
                  ) : null}
                  {detail.run.error ? <p className="mt-2 font-mono text-[11px] text-bad">{detail.run.error}</p> : null}
                </div>

                <ol className="flex flex-col gap-2">
                  {(detail.run.steps ?? []).map((s) => {
                    const Icon = STATUS_ICON[s.status] ?? Circle;
                    return (
                      <li key={s.id} className="rounded-[7px] border border-line bg-surface px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <Icon
                            size={12}
                            className={cn(
                              s.status === "done" ? "text-good" : s.status === "failed" || s.status === "denied" ? "text-bad" : "text-warn",
                              s.status === "running" && "animate-spin",
                            )}
                          />
                          <span className="tnum text-[11px] text-ink-faint">step {s.step_no}</span>
                          {s.tool ? <Badge tone="neutral" mono>{s.tool}</Badge> : null}
                          <span className="text-[11px] text-ink-faint">{fmtRelative(s.created_at)}</span>
                        </div>
                        {s.thought ? <p className="mt-1.5 text-[12px] leading-relaxed text-ink-dim">{s.thought}</p> : null}
                        {s.args && Object.keys(s.args as object).length ? (
                          <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] text-ink-mute">
                            {JSON.stringify(s.args, null, 2)}
                          </pre>
                        ) : null}
                        {s.result !== null && s.result !== undefined ? (
                          <pre className="mt-1.5 max-h-52 overflow-auto rounded border border-line bg-canvas px-2 py-1.5 font-mono text-[10.5px] text-ink-faint">
                            {typeof s.result === "string" ? s.result : JSON.stringify(s.result, null, 2)}
                          </pre>
                        ) : null}
                        {s.error ? <p className="mt-1 font-mono text-[10.5px] text-bad">{s.error}</p> : null}
                      </li>
                    );
                  })}
                  {detail.run.status === "running" ? (
                    <li className="flex items-center gap-2 px-1 py-2 text-[12px] text-ink-faint">
                      <Loader2 size={12} className="animate-spin" /> working
                    </li>
                  ) : null}
                </ol>
              </div>
            ) : (
              <p className="py-8 text-center text-[12.5px] text-ink-faint">
                Select a run on the left to inspect its plan and every tool call.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-3">
        <CardHeader title="Tool catalog" subtitle="What the agent can reach, and which of those calls write data" icon={ShieldAlert} />
        <div className="divide-y divide-line">
          {(data?.catalog ?? []).map((t) => (
            <div key={t.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Badge tone="neutral" mono>
                {t.name}
              </Badge>
              {t.writes ? <Badge tone="warn">write</Badge> : <Badge tone="muted">read</Badge>}
              {t.capability === "owner" ? <Badge tone="bad">owner only</Badge> : <Badge tone="neutral">{t.capability}</Badge>}
              <span className="flex-1 text-[12px] text-ink-mute">{t.description}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
