"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Button, Card, Field, Input } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@socialdeck.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { email, password });
      router.replace("/dashboard");
    } catch (err) {
      setError((err as { message?: string }).message ?? "sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-[360px]">
          <div className="mb-7 flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
              S
            </span>
            <span className="text-[15px] font-semibold tracking-tight">SocialDeck</span>
          </div>

          <h1 className="text-[20px] font-semibold tracking-tight">Sign in to the operations console</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-mute">
            Multi-account publishing, AI-assisted engagement, scheduled queues and 24/7 relays. Access is scoped by
            role: owner, admin, operator, analyst.
          </p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-3.5">
            <Field label="Work email" required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            {error ? (
              <p className="rounded-[7px] border border-bad/30 bg-bad-soft px-3 py-2 text-[12px] text-bad">{error}</p>
            ) : null}

            <Button type="submit" variant="primary" loading={busy} icon={busy ? undefined : KeyRound} className="h-9">
              {busy ? "Verifying" : "Sign in"}
            </Button>
          </form>

          <p className="mt-5 flex items-start gap-2 text-[11.5px] leading-relaxed text-ink-faint">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            Platform tokens and stream keys are stored encrypted with AES-256-GCM and are never returned to the
            browser. Sessions are httpOnly cookies.
          </p>
        </div>
      </div>

      <div className="hidden border-l border-line bg-surface lg:flex lg:flex-col lg:justify-center lg:px-14">
        <div className="max-w-md">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Production checklist</p>
          <ul className="mt-4 flex flex-col gap-3.5">
            {[
              ["Connect accounts", "OAuth for Facebook, Instagram, TikTok, YouTube, X, Threads, LinkedIn, Pinterest; manual credentials for Mastodon and RTMP targets."],
              ["Configure AI", "Point the reply engine at a hosted API or an on-premises model server - one interface, same behaviour."],
              ["Set reply policy", "Deterministic gates run before the model: risk, sentiment floor, escalation keywords, quiet hours, hourly caps."],
              ["Schedule without gaps", "Redis-backed queue with a SQL ledger, so restarts never lose a post or double-publish one."],
              ["Run relays unattended", "Loop playlists into any RTMP ingest with automatic restarts and per-stream event history."],
            ].map(([title, body]) => (
              <li key={title} className="flex gap-3">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <div>
                  <p className="text-[12.5px] font-medium text-ink-dim">{title}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">{body}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-8 rounded-[10px] border border-line bg-raised p-4">
            <p className="text-[11.5px] leading-relaxed text-ink-mute">
              First boot creates the owner account from SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or run{" "}
              <code className="font-mono text-[11px] text-ink-dim">npm run seed</code> for a full demonstration
              dataset.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
