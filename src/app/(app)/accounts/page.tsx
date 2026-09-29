"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Link2,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
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
  IconButton,
  Input,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  StatTile,
  Table,
  Td,
  Th,
  Tr,
  Toggle,
  statusTone,
  cn,
} from "@/components/ui";
import { PlatformIcon, platformColor, platformLabel } from "@/components/platforms";
import { api, fmtDateTime, fmtNumber, fmtRelative, useApi, useToast } from "@/lib/client";

interface Account {
  id: string;
  platform: string;
  label: string;
  handle: string | null;
  external_id: string;
  status: string;
  scopes: string[];
  token_expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  auto_publish: number;
  followers: number;
  following: number;
}

interface PlatformMeta {
  key: string;
  label: string;
  capabilities: string[];
  oauth: { authorizeUrl: string; scopes: string[]; usesPkce: boolean; requiresExternalId: boolean; docs: string };
  configured: boolean;
}

export default function AccountsPage() {
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [appOpen, setAppOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, reload } = useApi<{ accounts: Account[]; platforms: PlatformMeta[] }>("/api/accounts");
  const { data: appsData, reload: reloadApps } = useApi<{ apps: { platform: string; client_id: string; redirect_uri: string; configured: boolean; has_secret: boolean }[] }>("/api/oauth/apps");

  const [form, setForm] = useState({
    platform: "facebook",
    label: "",
    handle: "",
    externalId: "",
    accessToken: "",
    refreshToken: "",
    scopes: "",
    expiresInDays: "60",
    autoPublish: true,
  });

  const [appForm, setAppForm] = useState({ clientId: "", clientSecret: "", redirectUri: "" });

  const connected = data?.accounts ?? [];
  const platforms = data?.platforms ?? [];
  const expiringSoon = useMemo(
    () =>
      connected.filter((a) => {
        if (!a.token_expires_at) return false;
        const ms = new Date(a.token_expires_at.includes("T") ? a.token_expires_at : a.token_expires_at.replace(" ", "T") + "Z").getTime() - Date.now();
        return ms < 7 * 864e5;
      }),
    [connected],
  );

  const connectManual = async () => {
    setBusy("create");
    try {
      await api.post("/api/accounts", {
        platform: form.platform,
        label: form.label || platformLabel(form.platform) + " account",
        handle: form.handle,
        externalId: form.externalId,
        accessToken: form.accessToken,
        refreshToken: form.refreshToken || undefined,
        scopes: form.scopes,
        expiresInDays: Number(form.expiresInDays) || undefined,
        autoPublish: form.autoPublish,
      });
      toast.push("good", "Account connected. Tokens are sealed with AES-256-GCM before they touch the database.");
      setCreateOpen(false);
      setForm({ ...form, label: "", handle: "", externalId: "", accessToken: "", refreshToken: "" });
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not connect account");
    } finally {
      setBusy(null);
    }
  };

  const saveApp = async () => {
    if (!appOpen) return;
    setBusy("app");
    try {
      await api.post("/api/oauth/apps", {
        platform: appOpen,
        clientId: appForm.clientId,
        clientSecret: appForm.clientSecret || undefined,
        redirectUri: appForm.redirectUri || undefined,
      });
      toast.push("good", "OAuth credentials stored. Start the authorization flow to link accounts.");
      setAppOpen(null);
      setAppForm({ clientId: "", clientSecret: "", redirectUri: "" });
      await reloadApps();
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not store credentials");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, note: string) => {
    setBusy(id);
    try {
      await api.patch(`/api/accounts/${id}`, body);
      toast.push("good", note);
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const verify = async (a: Account) => {
    setBusy(a.id);
    try {
      const res = await api.post<{ ok: boolean; identity?: unknown; simulated?: boolean; error?: string }>(`/api/accounts/${a.id}`, { action: "verify" });
      if (res.ok) toast.push("good", `Credentials valid for ${a.handle ?? a.label}.`);
      else toast.push("info", res.error ?? "The platform rejected these credentials.");
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api.del(`/api/accounts/${id}`);
      toast.push("good", "Account disconnected and its tokens destroyed.");
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const appFor = (platform: string) => (appsData?.apps ?? []).find((a) => a.platform === platform);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Connect Facebook, Instagram, TikTok, YouTube, X, Threads, LinkedIn, Pinterest and Mastodon. One OAuth app per network, any number of linked accounts."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Plug size={11} /> {connected.length} linked
            </span>
            {expiringSoon.length ? (
              <span className="inline-flex items-center gap-1.5 text-warn">
                <AlertTriangle size={11} /> {expiringSoon.length} token expiring within 7 days
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-good">
                <ShieldCheck size={11} /> tokens healthy
              </span>
            )}
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon={KeyRound} onClick={() => setAppOpen(platforms[0]?.key ?? "facebook")}>
              OAuth apps
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
              Connect account
            </Button>
          </>
        }
      />

      <Grid cols={4} className="mb-3">
        <StatTile label="Linked accounts" value={connected.length} hint={`${platforms.length} platforms supported`} icon={Users} />
        <StatTile label="Auto publish on" value={connected.filter((a) => a.auto_publish).length} hint="accounts allowed to publish without review" icon={Plug} />
        <StatTile
          label="Tokens expiring"
          value={expiringSoon.length}
          tone={expiringSoon.length ? "warn" : "good"}
          hint="within the next 7 days"
          icon={KeyRound}
        />
        <StatTile
          label="OAuth apps configured"
          value={(appsData?.apps ?? []).filter((a) => a.configured).length}
          hint="networks ready for the connect flow"
          icon={ShieldCheck}
        />
      </Grid>

      <Card className="mb-3">
        <CardHeader title="Connected accounts" subtitle="Tokens are never returned by the API; only their expiry and status" icon={Link2} />
        {loading && !data ? (
          <CardBody>
            <Skeleton className="h-32" />
          </CardBody>
        ) : connected.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Platform</Th>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th>Token</Th>
                <Th>Audience</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {connected.map((a) => (
                <Tr key={a.id}>
                  <Td>
                    <span className="flex items-center gap-2">
                      <PlatformIcon platform={a.platform} />
                      {platformLabel(a.platform)}
                    </span>
                  </Td>
                  <Td>
                    <span className="block text-ink">{a.label}</span>
                    <span className="block font-mono text-[10.5px] text-ink-faint">{a.handle ?? a.external_id}</span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                    {a.last_error ? (
                      <span className="mt-1 block max-w-[240px] truncate font-mono text-[10px] text-bad">{a.last_error}</span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-faint">
                    {a.token_expires_at ? fmtRelative(a.token_expires_at) : "non-expiring"}
                  </Td>
                  <Td className="tnum text-ink-faint">
                    {fmtNumber(a.followers)} followers
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Toggle
                        checked={Boolean(a.auto_publish)}
                        onChange={(v) => patch(a.id, { autoPublish: v }, `Auto publish ${v ? "enabled" : "disabled"}.`)}
                        label="Auto publish"
                      />
                      <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === a.id} onClick={() => verify(a)}>
                        Verify
                      </Button>
                      <ConfirmButton
                        label="Disconnect"
                        confirmLabel="Confirm"
                        variant="ghost"
                        icon={Trash2}
                        onConfirm={() => remove(a.id)}
                      />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Plug}
            title="No accounts linked"
            description="Store an OAuth app for the network, then run the authorization flow. Manual token linking is available for internal deployments."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setCreateOpen(true)}>
                Connect account
              </Button>
            }
          />
        )}
      </Card>

      <Card>
        <CardHeader title="Platform capability matrix" subtitle="What each adapter can actually do, per the vendor API" icon={ShieldCheck} />
        <div className="divide-y divide-line">
          {platforms.map((p) => {
            const app = appFor(p.key);
            return (
              <div key={p.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <PlatformIcon platform={p.key} />
                <span className="w-[110px] text-[12.5px] text-ink">{p.label}</span>
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {p.capabilities.map((c) => (
                    <Badge key={c} tone="neutral">
                      {c}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {app?.configured ? <Badge tone="good">app configured</Badge> : <Badge tone="muted">no app</Badge>}
                  <a href={p.oauth.docs} target="_blank" rel="noreferrer">
                    <IconButton icon={ExternalLink} label={`${p.label} API documentation`} />
                  </a>
                  <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => setAppOpen(p.key)}>
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant={app?.configured ? "primary" : "ghost"}
                    disabled={!app?.configured}
                    icon={Link2}
                    onClick={() => {
                      window.location.href = `/api/oauth/${p.key}/start`;
                    }}
                  >
                    Authorize
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Connect an account"
        description="Use the OAuth flow for production. Manual linking accepts a long-lived token for internal or on-premise deployments."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Plug} loading={busy === "create"} onClick={connectManual}>
              Connect
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="Platform">
            <Select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {platforms.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Display label" hint="Shown in the console">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Corporate Facebook Page" />
          </Field>
          <Field label="Handle or page name" hint="Optional, used for display only">
            <Input value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="@brand" />
          </Field>
          <Field
            label="External account id"
            hint="The id at the platform, for example a Facebook Page id or YouTube channel id"
          >
            <Input value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} placeholder="1029384756" />
          </Field>
          <Field label="Access token" hint="Stored encrypted; never returned by any endpoint">
            <PasswordInput value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} placeholder="paste token" />
          </Field>
          <Field label="Refresh token" hint="Optional">
            <PasswordInput value={form.refreshToken} onChange={(e) => setForm({ ...form, refreshToken: e.target.value })} placeholder="paste refresh token" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scopes" hint="Comma separated">
              <Input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} placeholder="pages_manage_posts, pages_read_engagement" />
            </Field>
            <Field label="Expires in days" hint="Blank means non-expiring">
              <Input value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} />
            </Field>
          </div>
          <label className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
            <Toggle checked={form.autoPublish} onChange={(v) => setForm({ ...form, autoPublish: v })} label="Auto publish" />
            <span className="text-[12.5px] text-ink-dim">Allow scheduled jobs to publish to this account without manual approval</span>
          </label>
        </div>
      </Drawer>

      <Drawer
        open={Boolean(appOpen)}
        onClose={() => setAppOpen(null)}
        title={`OAuth app: ${appOpen ? platformLabel(appOpen) : ""}`}
        description="Credentials are encrypted at rest. The authorization flow uses PKCE where the network supports it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAppOpen(null)}>
              Cancel
            </Button>
            <Button variant="primary" icon={KeyRound} loading={busy === "app"} onClick={saveApp}>
              Store credentials
            </Button>
          </>
        }
      >
        {appOpen ? (
          <div className="flex flex-col gap-3.5">
            <div className="rounded-[7px] border border-line bg-raised p-3">
              <p className="text-[12px] leading-relaxed text-ink-mute">
                Authorize URL template
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-ink-dim">
                {platforms.find((p) => p.key === appOpen)?.oauth.authorizeUrl}
              </p>
              <p className="mt-2 text-[11px] text-ink-faint">
                Scopes requested: {(platforms.find((p) => p.key === appOpen)?.oauth.scopes ?? []).join(", ")}
                {platforms.find((p) => p.key === appOpen)?.oauth.usesPkce ? " - PKCE enabled" : ""}
              </p>
            </div>
            <Field label="Client id">
              <Input value={appForm.clientId} onChange={(e) => setAppForm({ ...appForm, clientId: e.target.value })} placeholder="client id from the developer portal" />
            </Field>
            <Field label="Client secret" hint="Leave blank to keep the stored secret">
              <PasswordInput value={appForm.clientSecret} onChange={(e) => setAppForm({ ...appForm, clientSecret: e.target.value })} placeholder="client secret" />
            </Field>
            <Field label="Redirect URI" hint="Must match the developer portal exactly">
              <Input value={appForm.redirectUri} onChange={(e) => setAppForm({ ...appForm, redirectUri: e.target.value })} placeholder="https://console.example.com/api/oauth/facebook/callback" />
            </Field>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
