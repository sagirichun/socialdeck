"use client";

import React, { useState } from "react";
import {
  AlertTriangle,
  BookMarked,
  Download,
  Filter,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  User,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { RankBars } from "@/components/charts";
import { api, fmtDateTime, fmtNumber, fmtRelative, useApi, useLocalState } from "@/lib/client";

interface Log {
  id: string;
  user_id: string | null;
  actor: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  detail_json: string | null;
  ip: string | null;
  ts: string;
}

interface Payload {
  logs: Log[];
  actions: { action: string; count: number }[];
  actors: { actor: string; count: number }[];
}

export default function AuditPage() {
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useLocalState("audit.query", "");
  const { data, loading, error, reload } = useApi<Payload>(`/api/audit?action=${encodeURIComponent(query)}&limit=120`, [query]);

  const detail = (raw: string | null) => {
    if (!raw) return "-";
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      return Object.entries(obj)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" ");
    } catch {
      return raw;
    }
  };

  const exportCsv = () => {
    const rows = (data?.logs ?? []).map((l) => [l.ts, l.actor ?? "", l.action, l.entity ?? "", l.entity_id ?? "", l.ip ?? ""].join(","));
    const blob = new Blob([["time,actor,action,entity,id,ip", ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable record of every mutation: who did what, to which entity, from where."
        meta={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={11} /> append only, retained 90 days
          </span>
        }
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={reload}>Refresh</Button>
            <Button variant="ghost" icon={Download} onClick={exportCsv}>Export CSV</Button>
          </>
        }
      />

      <Card>
        <CardHeader
          title="Filter"
          subtitle="Match any action name fragment, e.g. post, reply, stream, rule"
          icon={Filter}
        />
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(filter);
            }}
          >
            <div className="min-w-[260px] flex-1">
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Action</label>
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="post, reply, stream, rule" />
            </div>
            <Button type="submit">Apply</Button>
            {query ? (
              <Button type="button" variant="ghost" onClick={() => { setFilter(""); setQuery(""); }}>Clear</Button>
            ) : null}
          </form>
        </CardBody>
      </Card>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Events"
            subtitle={query ? `filtered by "${query}"` : "newest first"}
            icon={ScrollText}
            actions={<Badge tone="neutral">{data?.logs.length ?? 0} rows</Badge>}
          />
          {loading && !data ? (
            <CardBody><Skeleton className="h-[240px]" /></CardBody>
          ) : error ? (
            <EmptyState icon={AlertTriangle} title="Audit log unavailable" description={error.message} action={<Button icon={RefreshCw} onClick={reload}>Retry</Button>} />
          ) : data?.logs.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Detail</Th>
                  <Th align="right">IP</Th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((l) => (
                  <Tr key={l.id}>
                    <Td className="whitespace-nowrap text-ink-faint">{fmtRelative(l.ts)}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5">
                        <User size={11} className="text-ink-faint" />
                        <span className="text-[12px]">{l.actor ?? l.user_id ?? "system"}</span>
                      </span>
                    </Td>
                    <Td><Badge tone="neutral">{l.action}</Badge></Td>
                    <Td className="text-[11.5px] text-ink-mute">
                      {l.entity ?? "-"}{l.entity_id ? <span className="font-mono text-[10.5px] text-ink-faint"> {l.entity_id}</span> : null}
                    </Td>
                    <Td className="max-w-[300px] truncate font-mono text-[10.5px] text-ink-faint" title={detail(l.detail_json)}>{detail(l.detail_json)}</Td>
                    <Td align="right" className="font-mono text-[10.5px] text-ink-faint">{l.ip ?? "-"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState icon={ScrollText} title="No audit events" description="Mutations will be recorded here as the team works." />
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Top actions" subtitle="All time" icon={BookMarked} />
            <CardBody>
              {data?.actions.length ? (
                <RankBars data={data.actions.slice(0, 8).map((a) => ({ label: a.action, value: a.count }))} format={(v) => fmtNumber(v)} />
              ) : (
                <p className="text-[12px] text-ink-faint">No actions recorded yet.</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Actors" subtitle="Who performed the changes" icon={User} />
            <CardBody>
              {data?.actors.length ? (
                <ul className="flex flex-col gap-2">
                  {data.actors.map((a) => (
                    <li key={a.actor ?? "system"} className="flex items-center justify-between text-[12px]">
                      <span className="truncate text-ink-dim">{a.actor ?? "system"}</span>
                      <span className="tnum font-mono text-[11px] text-ink-faint">{fmtNumber(a.count)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-ink-faint">No actor activity yet.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
