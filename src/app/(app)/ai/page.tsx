"use client";

import React, { useState } from "react";
import {
  Bot,
  BrainCircuit,
  Check,
  Cpu,
  FlaskConical,
  KeyRound,
  Plus,
  Server,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
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
} from "@/components/ui";
import { api, fmtRelative, useApi, useToast } from "@/lib/client";

interface Provider {
  id: string;
  kind: string;
  label: string;
  base_url: string | null;
  model: string;
  models: string[];
  temperature: number;
  max_tokens: number;
  enabled: boolean;
  is_default: boolean;
  purpose: string;
  has_key: boolean;
  created_at: string;
}

const KIND_ICON: Record<string, typeof Bot> = {
  openai: Sparkles,
  anthropic: BrainCircuit,
  ollama: Cpu,
  "lm-studio": Cpu,
  "openai-compatible": Server,
};

const KIND_HINT: Record<string, string> = {
  openai: "api.openai.com, host-relative path appended automatically",
  anthropic: "api.anthropic.com messages API",
  ollama: "local daemon, usually http://127.0.0.1:11434",
  "lm-studio": "local server, usually http://127.0.0.1:1234/v1",
  "openai-compatible": "any gateway speaking the OpenAI schema: vLLM, llama.cpp, 9Router, LiteLLM, OpenRouter",
};

const PRESETS = [
  { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  { label: "Ollama (local)", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3.1:8b" },
  { label: "LM Studio (local)", kind: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
  { label: "Custom gateway", kind: "openai-compatible", baseUrl: "http://192.168.0.2:8081/v1", model: "brsk/auto" },
];

export default function AiPage() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKey: "",
    temperature: "0.4",
    maxTokens: "800",
    purpose: "general",
    enabled: true,
    isDefault: true,
  });

  const { data, loading, reload } = useApi<{ providers: Provider[]; purposes: string[] }>("/api/ai/providers");

  const providers = data?.providers ?? [];
  const ready = providers.filter((p) => p.enabled);
  const local = providers.filter((p) => ["ollama", "lm-studio"].includes(p.kind));

  const create = async () => {
    setBusy("create");
    try {
      await api.post("/api/ai/providers", {
        kind: form.kind,
        label: form.label,
        baseUrl: form.baseUrl,
        model: form.model,
        apiKey: form.apiKey || undefined,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        purpose: form.purpose,
        enabled: form.enabled,
        isDefault: form.isDefault,
      });
      toast.push("good", "Provider saved and encrypted.");
      setOpen(false);
      setForm({ ...form, apiKey: "" });
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not save the provider");
    } finally {
      setBusy(null);
    }
  };

  const test = async (p: Provider) => {
    setBusy("test" + p.id);
    setTestResult(null);
    try {
      const res = await api.post<{ ok: boolean; latencyMs: number; model: string; sample: string; error?: string }>(
        `/api/ai/providers/${p.id}`,
        { action: "test" },
      );
      setTestResult({
        id: p.id,
        ok: res.ok,
        text: res.ok ? `${res.latencyMs} ms round trip, answered by ${res.model}: ${res.sample}` : res.error ?? "test failed",
      });
      toast.push(res.ok ? "good" : "bad", res.ok ? "Provider reachable." : "Provider test failed.");
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Test failed");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, note: string) => {
    setBusy(id);
    try {
      await api.patch(`/api/ai/providers/${id}`, body);
      toast.push("good", note);
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    await api.del(`/api/ai/providers/${id}`);
    toast.push("good", "Provider removed.");
    await reload();
  };

  return (
    <>
      <PageHeader
        title="AI control plane"
        description="Every generative feature in the console routes through these providers: reply drafting, classification, captions, alt text, content generation and the operations agent."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <Zap size={11} /> {ready.length} enabled
            </span>
            <span className="inline-flex items-center gap-1.5">
              {local.length ? <Cpu size={11} /> : <Server size={11} />} {local.length} local endpoint(s)
            </span>
          </>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            Add provider
          </Button>
        }
      />

      <Grid cols={4} className="mb-3">
        <StatTile label="Providers" value={providers.length} hint="configured endpoints" icon={Server} />
        <StatTile label="Enabled" value={ready.length} tone={ready.length ? "good" : "warn"} hint="available to the workers" icon={Zap} />
        <StatTile label="Local endpoints" value={local.length} hint="run without leaving the network" icon={Cpu} />
        <StatTile
          label="Default model"
          value={providers.find((p) => p.is_default)?.model ?? "-"}
          hint={providers.find((p) => p.is_default)?.label ?? "none pinned"}
          icon={Bot}
        />
      </Grid>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-5">
        {PRESETS.map((p) => {
          const Icon = KIND_ICON[p.kind] ?? Server;
          return (
            <button
              key={p.label}
              onClick={() => {
                setForm({
                  ...form,
                  kind: p.kind,
                  label: p.label,
                  baseUrl: p.baseUrl,
                  model: p.model,
                });
                setOpen(true);
              }}
              className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-raised"
            >
              <span className="flex items-center gap-2 text-[12.5px] text-ink">
                <Icon size={13} className="text-accent" />
                {p.label}
              </span>
              <span className="font-mono text-[10.5px] leading-relaxed text-ink-faint">{p.model}</span>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Configured providers" subtitle="Keys are encrypted with AES-256-GCM and never returned by the API" icon={KeyRound} />
        {loading && !data ? (
          <CardBody>
            <Skeleton className="h-32" />
          </CardBody>
        ) : providers.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th>Endpoint</Th>
                <Th>Purpose</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const Icon = KIND_ICON[p.kind] ?? Server;
                return (
                  <Tr key={p.id}>
                    <Td>
                      <span className="flex items-center gap-2">
                        <Icon size={13} className="text-ink-faint" />
                        <span className="text-ink">{p.label}</span>
                      </span>
                      <span className="mt-1 flex gap-1.5">
                        {p.is_default ? <Badge tone="good">default</Badge> : null}
                        {p.enabled ? null : <Badge tone="muted">disabled</Badge>}
                        {p.has_key ? <Badge tone="neutral">key set</Badge> : <Badge tone="warn">no key</Badge>}
                      </span>
                    </Td>
                    <Td className="font-mono text-[11px] text-ink-dim">{p.model}</Td>
                    <Td className="max-w-[240px]">
                      <span className="block truncate font-mono text-[10.5px] text-ink-faint">{p.base_url ?? "vendor default"}</span>
                      <span className="text-[10.5px] text-ink-faint">t={p.temperature} max={p.max_tokens}</span>
                    </Td>
                    <Td>
                      <Select
                        value={p.purpose}
                        onChange={(e) => patch(p.id, { purpose: e.target.value }, "Routing updated.")}
                        className="w-[130px]"
                      >
                        {(data?.purposes ?? []).map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Toggle
                          checked={p.enabled}
                          onChange={(v) => patch(p.id, { enabled: v }, `Provider ${v ? "enabled" : "disabled"}.`)}
                          label="Enabled"
                        />
                        <Button size="sm" variant="ghost" icon={FlaskConical} loading={busy === "test" + p.id} onClick={() => test(p)}>
                          Test
                        </Button>
                        {!p.is_default ? (
                          <Button size="sm" variant="ghost" icon={Check} onClick={() => patch(p.id, { isDefault: true }, "Default provider pinned.")}>
                            Set default
                          </Button>
                        ) : null}
                        <ConfirmButton label="Remove" confirmLabel="Confirm" variant="ghost" icon={Trash2} onConfirm={() => remove(p.id)} />
                      </div>
                      {testResult?.id === p.id ? (
                        <p className={testResult.ok ? "mt-1.5 text-[11px] text-good" : "mt-1.5 text-[11px] text-bad"}>{testResult.text}</p>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Bot}
            title="No AI provider configured"
            description="Add an external API key or point at a local server. Local providers are reached over the private network and never leave it."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                Add provider
              </Button>
            }
          />
        )}
      </Card>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add AI provider"
        description="Any OpenAI-compatible endpoint works: cloud APIs, local daemons, or an internal router."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Wand2} loading={busy === "create"} onClick={create}>
              Save provider
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="Interface">
            <Select
              value={form.kind}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.kind === e.target.value);
                setForm({ ...form, kind: e.target.value, label: p?.label ?? form.label, baseUrl: p?.baseUrl ?? form.baseUrl, model: p?.model ?? form.model });
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="ollama">Ollama</option>
              <option value="lm-studio">LM Studio</option>
              <option value="openai-compatible">OpenAI-compatible gateway</option>
            </Select>
          </Field>
          <p className="text-[11px] leading-relaxed text-ink-faint">{KIND_HINT[form.kind]}</p>
          <Field label="Label">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </Field>
          <Field label="Base URL" hint="Include the version segment, for example /v1">
            <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </Field>
          <Field label="Model">
            <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label="API key" hint="Not required for local endpoints">
            <PasswordInput value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature">
              <Input value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} />
            </Field>
            <Field label="Max tokens">
              <Input value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
            </Field>
          </div>
          <Field label="Purpose" hint="Routing hint for workload separation">
            <Select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
              {(data?.purposes ?? ["general", "replies", "content", "analysis"]).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
              <Toggle checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} label="Default provider" />
              <span className="text-[12.5px] text-ink-dim">Use this provider when no rule specifies one</span>
            </label>
            <label className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
              <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
              <span className="text-[12.5px] text-ink-dim">Available to the reply, content and analysis workers</span>
            </label>
          </div>
        </div>
      </Drawer>
    </>
  );
}
