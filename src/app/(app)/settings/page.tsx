"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Building2,
  Database,
  Gauge,
  Globe,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  EmptyState,
  Field,
  Grid,
  Input,
  KeyValue,
  PageHeader,
  Skeleton,
  StatTile,
  Tabs,
  Toggle,
  useToast,
} from "@/components/ui";
import { api, fmtNumber, useApi } from "@/lib/client";

interface SettingsPayload {
  workspace: {
    name: string;
    url: string;
    outboundMode: string;
    timezone: string;
    dataDir: string;
    mediaDir: string;
    redis: boolean;
    ffmpeg: string | null;
    retentionDays: number;
  };
  accounts: { id: string; platform: string; handle: string | null; status: string; token_expires_at: string | null }[];
  counts: { users: number; accounts: number; posts: number; rules: number; streams: number; media: number };
}

export default function SettingsPage() {
  const toast = useToast();
  const [tab, setTab] = useState("workspace");
  const { data, loading, error, reload } = useApi<SettingsPayload>("/api/settings");
  const [form, setForm] = useState({ name: "", url: "", timezone: "", retentionDays: 90 });
  const [seeded, setSeeded] = useState(false);

  const workspace = data?.workspace;
  React.useEffect(() => {
    if (workspace && !seeded) {
      setForm({
        name: workspace.name,
        url: workspace.url,
        timezone: workspace.timezone,
        retentionDays: workspace.retentionDays,
      });
      setSeeded(true);
    }
  }, [workspace, seeded]);

  const dirty = useMemo(() => {
    if (!workspace) return false;
    return (
      form.name !== workspace.name ||
      form.url !== workspace.url ||
      form.timezone !== workspace.timezone ||
      Number(form.retentionDays) !== workspace.retentionDays
    );
  }, [form, workspace]);

  const save = async () => {
    try {
      await api.patch("/api/settings", form);
      toast.push("good", "Workspace settings saved.");
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Save failed.");
    }
  };

  if (error) {
    return <EmptyState icon={AlertTriangle} title="Settings unavailable" description={error.message} action={<Button icon={RefreshCw} onClick={reload}>Retry</Button>} />;
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace identity, retention policy and the integration bindings this deployment runs on."
        meta={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={11} /> secrets are encrypted at rest
          </span>
        }
        actions={
          <>
            <Button variant="ghost" icon={RefreshCw} onClick={reload}>Refresh</Button>
            <Button icon={Save} disabled={!dirty} onClick={save}>Save changes</Button>
          </>
        }
      />

      <Grid cols={4}>
        <StatTile label="Team seats" value={fmtNumber(data?.counts.users)} icon={Users} hint="owner admin operator viewer" />
        <StatTile label="Connected accounts" value={fmtNumber(data?.counts.accounts)} icon={Globe} hint="across all networks" />
        <StatTile label="Published posts" value={fmtNumber(data?.counts.posts)} icon={Gauge} hint="in the ledger" />
        <StatTile label="Reply rules" value={fmtNumber(data?.counts.rules)} icon={ShieldCheck} hint={`${data?.counts.streams ?? 0} relay channel(s)`} />
      </Grid>

      <div className="mt-3">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "workspace", label: "Workspace" },
            { value: "integrations", label: "Integrations" },
            { value: "accounts", label: "Account health" },
          ]}
        />
      </div>

      {loading && !data ? (
        <Card className="mt-3"><CardBody><Skeleton className="h-[260px]" /></CardBody></Card>
      ) : tab === "workspace" ? (
        <Card className="mt-3">
          <CardHeader title="Workspace" subtitle="Displayed in the console header and used for outbound links" icon={Building2} />
          <CardBody>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Workspace name" hint="shown to the team">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Public base URL" hint="platforms fetch media from this host, so it must be reachable">
                <Input mono value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </Field>
              <Field label="Timezone" hint="scheduling and quiet hours resolve against it">
                <Input mono value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
              </Field>
              <Field label="Audit retention (days)" hint="older job records are purged automatically">
                <Input
                  type="number"
                  min={7}
                  max={3650}
                  value={form.retentionDays}
                  onChange={(e) => setForm({ ...form, retentionDays: Number(e.target.value) })}
                />
              </Field>
            </div>
            <Divider className="my-4" />
            <KeyValue
              rows={[
                { label: "Outbound mode", value: workspace?.outboundMode === "live" ? "live (real API writes)" : "sandbox (simulated writes)" },
                { label: "Job backend", value: workspace?.redis ? "bullmq + redis" : "inline timer wheel" },
                { label: "ffmpeg", value: workspace?.ffmpeg ?? "not detected", mono: true },
                { label: "Data directory", value: workspace?.dataDir ?? "-", mono: true },
                { label: "Media directory", value: workspace?.mediaDir ?? "-", mono: true },
              ]}
            />
            <p className="mt-3 rounded-[6px] border border-line bg-raised p-3 text-[11.5px] leading-relaxed text-ink-mute">
              Outbound mode is read from the process environment at boot and cannot be changed from the console.
              Set OUTBOUND_MODE to live only after every platform app has been reviewed by the operator.
            </p>
          </CardBody>
        </Card>
      ) : tab === "integrations" ? (
        <Card className="mt-3">
          <CardHeader title="Integrations" subtitle="Runtime bindings resolved at boot" icon={Terminal} />
          <CardBody>
            <KeyValue
              rows={[
                { label: "Job backend", value: workspace?.redis ? "bullmq + redis (durable, retryable)" : "inline timer wheel (single process)" },
                { label: "Queue durability", value: "job ledger mirrored to SQL, independent of the broker" },
                { label: "ffmpeg binary", value: workspace?.ffmpeg ?? "missing from PATH", mono: true },
                { label: "Media storage", value: workspace?.mediaDir ?? "-", mono: true },
                { label: "Public media base", value: workspace?.url ?? "-", mono: true },
              ]}
            />
            <div className="mt-4 flex flex-col gap-3">
              {[
                { label: "AI providers", hint: "external APIs and local routers", href: "/ai" },
                { label: "OAuth applications", hint: "client id, secret and redirect per network", href: "/accounts" },
                { label: "Webhook receivers", hint: "signed ingress endpoints per platform", href: "/accounts" },
              ].map((row) => (
                <a key={row.href} href={row.href} className="flex items-center justify-between rounded-[6px] border border-line bg-raised px-3 py-2.5 transition-colors hover:border-line-strong">
                  <span className="flex flex-col">
                    <span className="text-[12.5px] font-medium text-ink-dim">{row.label}</span>
                    <span className="text-[11px] text-ink-faint">{row.hint}</span>
                  </span>
                  <Badge tone="neutral">configure</Badge>
                </a>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card className="mt-3">
          <CardHeader title="Account health" subtitle="Token expiry across every connected network" icon={KeyRound} />
          {data?.accounts.length ? (
            <CardBody className="flex flex-col gap-2">
              {data.accounts.map((a) => {
                const expired = a.token_expires_at ? new Date(a.token_expires_at).getTime() < Date.now() : false;
                return (
                  <div key={a.id} className="flex items-center justify-between rounded-[6px] border border-line bg-raised px-3 py-2.5">
                    <span className="flex flex-col">
                      <span className="text-[12.5px] font-medium text-ink-dim">{a.handle ?? a.id}</span>
                      <span className="text-[11px] text-ink-faint">{a.platform}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={a.status === "connected" ? "good" : a.status === "expired" ? "bad" : "warn"}>{a.status}</Badge>
                      {a.token_expires_at ? (
                        <span className={expired ? "text-[11px] text-bad" : "text-[11px] text-ink-faint"}>
                          {expired ? "token expired" : `expires ${new Date(a.token_expires_at).toLocaleDateString()}`}
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-faint">static token</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </CardBody>
          ) : (
            <EmptyState icon={Globe} title="No accounts connected" description="Connect a platform from the Accounts screen." />
          )}
        </Card>
      )}
    </>
  );
}
