"use client";

import React, { useState } from "react";
import {
  AlertTriangle,
  Check,
  Filter,
  MessageSquareReply,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
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
  Select,
  Skeleton,
  StatTile,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  Toggle,
  Tr,
} from "@/components/ui";
import { PlatformIcon, platformLabel } from "@/components/platforms";
import { api, fmtNumber, fmtRelative, useApi, useToast } from "@/lib/client";

interface Rule {
  id: string;
  name: string;
  account_id: string | null;
  platform: string | null;
  auto_reply: number;
  require_approval: number;
  tone: string;
  language: string;
  escalate_keywords: string[];
  escalation_email: string | null;
  max_replies_per_hour: number;
  provider_id: string | null;
  persona: string | null;
  enabled: number;
  updated_at: string;
  handle: string | null;
}

interface Exemplar {
  id: string;
  body: string;
  good: number;
  note: string | null;
  created_at: string;
}

export default function RulesPage() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState("rules");

  const { data, loading, reload } = useApi<{
    rules: Rule[];
    accounts: { id: string; platform: string; handle: string | null; label: string }[];
    providers: { id: string; label: string; model: string }[];
    exemplars: Exemplar[];
    counts: { blocked: number; pending: number; sent: number };
  }>("/api/rules");

  const [form, setForm] = useState({
    name: "",
    accountId: "",
    autoReply: false,
    requireApproval: true,
    tone: "professional",
    language: "auto",
    escalateKeywords: "refund, lawsuit, lawyer, press, media, bribery",
    escalationEmail: "",
    maxRepliesPerHour: "20",
    providerId: "",
    persona: "",
  });

  const [exemplar, setExemplar] = useState({ body: "", good: true, note: "" });

  const create = async () => {
    setBusy("create");
    try {
      await api.post("/api/rules", {
        name: form.name || "Untitled rule",
        accountId: form.accountId || null,
        autoReply: form.autoReply,
        requireApproval: form.requireApproval,
        tone: form.tone,
        language: form.language,
        escalateKeywords: form.escalateKeywords,
        escalationEmail: form.escalationEmail || null,
        maxRepliesPerHour: Number(form.maxRepliesPerHour),
        providerId: form.providerId || null,
        persona: form.persona || null,
      });
      toast.push("good", "Reply rule saved.");
      setOpen(false);
      setForm({ ...form, name: "", persona: "" });
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Could not save the rule");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, note: string) => {
    setBusy(id);
    try {
      await api.patch(`/api/rules/${id}`, body);
      toast.push("good", note);
      await reload();
    } catch (err) {
      toast.push("bad", (err as { message?: string }).message ?? "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    await api.del(`/api/rules/${id}`);
    toast.push("good", "Rule removed.");
    await reload();
  };

  const addExemplar = async () => {
    if (!exemplar.body.trim()) return;
    setBusy("exemplar");
    try {
      await api.post("/api/rules", { exemplar: { ...exemplar } });
      toast.push("good", exemplar.good ? "Positive example added to the style memory." : "Negative example recorded; the drafter will avoid this shape.");
      setExemplar({ body: "", good: true, note: "" });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const rules = data?.rules ?? [];

  return (
    <>
      <PageHeader
        title="Reply policy"
        description="Rules decide what the AI may answer, in which language and tone, and when a message must escalate to a human instead."
        meta={
          <>
            <span className="inline-flex items-center gap-1.5">
              <ShieldAlert size={11} /> {fmtNumber(data?.counts.blocked)} escalated so far
            </span>
            <span className="inline-flex items-center gap-1.5">
              <MessageSquareReply size={11} /> {fmtNumber(data?.counts.sent)} replies sent
            </span>
          </>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
            New rule
          </Button>
        }
      />

      <Grid cols={3} className="mb-3">
        <StatTile label="Active rules" value={rules.filter((r) => r.enabled).length} hint={`${rules.length} configured`} icon={Filter} />
        <StatTile
          label="Automated"
          value={rules.filter((r) => r.auto_reply && !r.require_approval).length}
          tone={rules.some((r) => r.auto_reply && !r.require_approval) ? "warn" : "good"}
          hint="send without human review"
          icon={Sparkles}
        />
        <StatTile label="Style examples" value={data?.exemplars.length ?? 0} hint="few-shot memory for the drafter" icon={MessageSquareReply} />
      </Grid>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "rules", label: "Rules", count: rules.length },
          { key: "style", label: "Style memory", count: data?.exemplars.length ?? 0 },
        ]}
      />

      {tab === "rules" ? (
        <Card>
          <CardHeader title="Configured rules" subtitle="Evaluated per inbound message; the most specific match wins" icon={Filter} />
          {loading && !data ? (
            <CardBody>
              <Skeleton className="h-32" />
            </CardBody>
          ) : rules.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Rule</Th>
                  <Th>Scope</Th>
                  <Th>Behaviour</Th>
                  <Th>Guardrails</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <span className="block text-ink">{r.name}</span>
                      <span className="block text-[10.5px] text-ink-faint">updated {fmtRelative(r.updated_at)}</span>
                      {r.persona ? (
                        <span className="mt-1 block max-w-[280px] truncate text-[10.5px] text-ink-faint" title={r.persona}>
                          persona: {r.persona}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {r.platform ? (
                        <span className="flex items-center gap-2">
                          <PlatformIcon platform={r.platform} />
                          {r.handle ?? platformLabel(r.platform)}
                        </span>
                      ) : (
                        <Badge tone="neutral">all accounts</Badge>
                      )}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1.5">
                        <Badge tone={r.auto_reply ? "good" : "muted"}>{r.auto_reply ? "auto reply" : "manual only"}</Badge>
                        <Badge tone={r.require_approval ? "warn" : "neutral"}>{r.require_approval ? "needs approval" : "sends directly"}</Badge>
                        <Badge tone="neutral">{r.tone}</Badge>
                        <Badge tone="neutral">{r.language}</Badge>
                      </span>
                    </Td>
                    <Td className="max-w-[220px]">
                      <span className="block text-[11px] text-ink-mute">
                        {r.max_replies_per_hour}/h cap{r.escalation_email ? ` - escalates to ${r.escalation_email}` : ""}
                      </span>
                      {r.escalate_keywords.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {r.escalate_keywords.slice(0, 4).map((k) => (
                            <Badge key={k} tone="bad">
                              {k}
                            </Badge>
                          ))}
                          {r.escalate_keywords.length > 4 ? <Badge tone="muted">+{r.escalate_keywords.length - 4}</Badge> : null}
                        </span>
                      ) : null}
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Toggle checked={Boolean(r.enabled)} onChange={(v) => patch(r.id, { enabled: v }, `Rule ${v ? "enabled" : "disabled"}.`)} label="Enabled" />
                        <ConfirmButton label="Delete" confirmLabel="Confirm" variant="ghost" icon={Trash2} onConfirm={() => remove(r.id)} />
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState
              icon={Filter}
              title="No reply rules"
              description="Without a rule the reply worker stays silent, which is the safe default. Add one to let the AI draft answers."
              action={
                <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>
                  New rule
                </Button>
              }
            />
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader title="Teach the drafter" subtitle="Good examples steer tone and structure; bad ones are avoided" icon={Sparkles} />
            <CardBody>
              <div className="flex flex-col gap-3">
                <Field label="Example reply">
                  <Textarea rows={4} value={exemplar.body} onChange={(e) => setExemplar({ ...exemplar, body: e.target.value })} />
                </Field>
                <Field label="Note" hint="Why this example is good or bad">
                  <Input value={exemplar.note} onChange={(e) => setExemplar({ ...exemplar, note: e.target.value })} />
                </Field>
                <div className="flex items-center gap-2">
                  <Button
                    variant={exemplar.good ? "primary" : "ghost"}
                    icon={Check}
                    onClick={() => setExemplar({ ...exemplar, good: true })}
                  >
                    Good example
                  </Button>
                  <Button
                    variant={!exemplar.good ? "primary" : "ghost"}
                    icon={X}
                    onClick={() => setExemplar({ ...exemplar, good: false })}
                  >
                    Avoid this
                  </Button>
                  <Button variant="primary" loading={busy === "exemplar"} onClick={addExemplar} className="ml-auto">
                    Add to memory
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Style memory" subtitle="Injected into every drafting prompt as few-shot guidance" icon={MessageSquareReply} />
            <div className="divide-y divide-line">
              {(data?.exemplars ?? []).map((e) => (
                <div key={e.id} className="px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <Badge tone={e.good ? "good" : "bad"}>{e.good ? "good" : "avoid"}</Badge>
                    <span className="text-[10.5px] text-ink-faint">{fmtRelative(e.created_at)}</span>
                  </div>
                  <p className="text-[12px] leading-relaxed text-ink-dim">{e.body}</p>
                  {e.note ? <p className="mt-1 text-[11px] text-ink-faint">{e.note}</p> : null}
                </div>
              ))}
              {!data?.exemplars.length ? (
                <EmptyState icon={Sparkles} title="No examples yet" description="Add a few good replies to lock in your house voice." />
              ) : null}
            </div>
          </Card>
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="New reply rule"
        description="Leave the account empty to apply the rule to every connected account."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Plus} loading={busy === "create"} onClick={create}>
              Save rule
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3.5">
          <Field label="Rule name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Product questions" />
          </Field>
          <Field label="Account scope">
            <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
              <option value="">All accounts</option>
              {(data?.accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {platformLabel(a.platform)} - {a.handle ?? a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Drafting provider">
            <Select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
              <option value="">Workspace default</option>
              {(data?.providers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} - {p.model}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tone">
              <Select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
                {["professional", "friendly", "formal", "concise", "apologetic", "playful"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Language">
              <Select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                {["auto", "id-ID", "en-US", "ms-MY", "ar-SA", "zh-CN"].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Persona" hint="Optional brief that shapes the voice, for example: patient support engineer, no marketing language">
            <Textarea rows={3} value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
          </Field>
          <Field label="Escalation keywords" hint="Comma separated. A match forces a human handoff.">
            <Input value={form.escalateKeywords} onChange={(e) => setForm({ ...form, escalateKeywords: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Escalation email">
              <Input value={form.escalationEmail} onChange={(e) => setForm({ ...form, escalationEmail: e.target.value })} placeholder="support@example.com" />
            </Field>
            <Field label="Replies per hour cap">
              <Input value={form.maxRepliesPerHour} onChange={(e) => setForm({ ...form, maxRepliesPerHour: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
              <Toggle checked={form.autoReply} onChange={(v) => setForm({ ...form, autoReply: v })} label="Auto reply" />
              <span className="text-[12.5px] text-ink-dim">Draft a reply automatically when a matching message arrives</span>
            </label>
            <label className="flex items-center gap-2.5 rounded-[7px] border border-line bg-raised px-3 py-2.5">
              <Toggle checked={form.requireApproval} onChange={(v) => setForm({ ...form, requireApproval: v })} label="Require approval" />
              <span className="text-[12.5px] text-ink-dim">Hold every draft in the review queue instead of sending it</span>
            </label>
          </div>
          <div className="flex items-start gap-2 rounded-[7px] border border-warn/30 bg-warn-soft px-3 py-2.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-[11.5px] leading-relaxed text-ink-mute">
              With approval off, drafted replies post automatically. Crisis-classified messages are always escalated regardless of this
              setting, and every send is rate limited to the cap above.
            </p>
          </div>
        </div>
      </Drawer>
    </>
  );
}
