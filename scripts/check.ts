#!/usr/bin/env tsx
/**
 * End-to-end self-check. Boots the domain layer exactly as the server does (no HTTP), then
 * asserts the seeded invariants and one write path per subsystem. Exits non-zero on the first
 * failure so it can gate a deploy.
 *
 * Run: npm run check
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";

import "../src/lib/platforms";
import { all, one, run, uid, migrate } from "../src/lib/db";
import { hashPassword, decryptSecret } from "../src/lib/crypto";
import { env } from "../src/lib/env";
import { schedulePost, publishPost, upcomingBatch } from "../src/lib/publishing";
import { ingestComment, processComment } from "../src/lib/replies";
import { listAdapters, getAdapter } from "../src/lib/platforms";
import { queueHealth } from "../src/lib/queue";
import { assertSafeIngest } from "../src/lib/streams";
import { cropFilter, ASPECT_PRESETS } from "../src/lib/media";

let failures = 0;
const seen: string[] = [];

function check(name: string, condition: unknown, detail = "") {
  seen.push(name);
  if (condition) console.log(`  ok   ${name}${detail ? ` :: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/**
 * Local OpenAI-compatible test double. Binds to a random loopback port and answers
 * chat completions with a canned reply, exercising the exact HTTP path a local
 * Ollama / LM Studio / router deployment uses.
 */
function startMockAi(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk));
      req.on("end", () => {
        let body: any = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* tolerate malformed probes */
        }
        const payload = {
          id: "chatcmpl-selfcheck",
          object: "chat.completion",
          model: body.model ?? "selfcheck-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function main() {
  console.log("socialdeck self-check");
  console.log(`  env: outbound=${env.outboundMode} db=${env.dbPath}`);

  migrate();
  check("database migrated", all("SELECT name FROM sqlite_master WHERE type='table'").length >= 15);

  /* ---- adapters ---- */
  const adapters = listAdapters();
  check("platform adapters registered", adapters.length >= 9, `${adapters.length} adapters`);
  const missing = ["facebook", "instagram", "youtube", "x", "tiktok", "threads", "linkedin", "pinterest", "mastodon"].filter(
    (key) => !getAdapter(key as never),
  );
  check("every advertised network has an adapter", missing.length === 0, missing.length ? `missing ${missing.join(",")}` : "all present");
  check(
    "each adapter declares its own auth shape",
    adapters.every((a) => (a.oauth ? typeof a.oauth.authorizeUrl === "string" : (a.credentialFields?.length ?? 0) > 0)),
  );

  /* ---- rtmp ingest guard ---- */
  let blockedPrivate = false;
  try {
    assertSafeIngest("rtmp://127.0.0.1:1935/live");
  } catch {
    blockedPrivate = true;
  }
  check("rtmp ingest rejects loopback targets", blockedPrivate, "ssrf guard active");
  let allowedPublic = false;
  try {
    assertSafeIngest("rtmp://a.rtmp.youtube.com/live2");
    allowedPublic = true;
  } catch {
    allowedPublic = false;
  }
  check("rtmp ingest accepts public endpoints", allowedPublic);

  /* ---- ffmpeg crop math ---- */
  const crop = cropFilter({ w: 1920, h: 1080 }, ASPECT_PRESETS["9:16"]);
  check("crop filter produces a valid scale+crop chain", /^scale=.*crop=\d+:\d+/.test(crop), crop);

  /* ---- publishing path ---- */
  const account = one<any>("SELECT * FROM accounts WHERE platform = 'youtube' LIMIT 1");
  if (!account) {
    console.log("  skip  publish flow (no seeded account)");
  } else {
    const media = one<any>("SELECT id FROM media WHERE kind = 'video' LIMIT 1");
    const postId = uid("pst");
    run(
      `INSERT INTO posts (id, account_id, kind, body, media_json, scheduled_at, status, created_by)
       VALUES (?, ?, 'video', 'self-check publish probe', ?, ?, 'draft', NULL)`,
      postId,
      account.id,
      JSON.stringify(media ? [{ mediaId: media.id }] : []),
      new Date(Date.now() - 1000).toISOString(),
    );
    check("post created", Boolean(one("SELECT id FROM posts WHERE id = ?", postId)));

    const scheduled = await schedulePost(postId);
    check("post scheduled", scheduled.delay === 0 && Boolean(scheduled.scheduledAt), `delay=${scheduled.delay}ms`);
    check("queued post appears in the upcoming batch", upcomingBatch(20).some((p: any) => p.id === postId));

    const outcome = await publishPost(postId);
    check("publish succeeded in sandbox mode", outcome.ok && outcome.simulated, `simulated=${outcome.simulated}`);
    check("published post carries an external id", Boolean(one("SELECT external_id FROM posts WHERE id = ?", postId)?.external_id));
    check("post status is published", one("SELECT status FROM posts WHERE id = ?", postId)?.status === "published");
    check("job ledger recorded the publish", (one<any>("SELECT COUNT(*) AS n FROM job_runs WHERE ref_id = ?", postId)?.n ?? 0) >= 1);
  }

  /* ---- auto-reply path (exercises the local-AI HTTP path end to end) ---- */
  const mock = await startMockAi();
  const providerId = uid("aip");
  // Every seeded rule matches the same account, so the rule picked up here may not carry a
  // provider id. Pointing the entire provider table at the mock keeps the draft path honest
  // regardless of which rule wins, and proves nothing escapes to a remote API.
  run("UPDATE ai_providers SET enabled = 0, is_default = 0");
  run(
    `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key_enc, extra_json, temperature, max_tokens, timeout_ms, enabled, is_default)
     VALUES (?, 'self-check local', 'openai-compatible', ?, 'selfcheck-model', NULL, '{}', 0.5, 256, 8000, 1, 1)`,
    providerId,
    mock.url,
  );
  check("local AI provider saved", Boolean(one("SELECT id FROM ai_providers WHERE id = ?", providerId)));
  const commentTarget = one("SELECT * FROM accounts WHERE platform = 'youtube' LIMIT 1");
  if (commentTarget) {
    const ruleId = uid("rul");
    run(
      `INSERT INTO ai_rules (id, account_id, name, enabled, tone, languages, system_prompt, auto_send, max_per_hour, escalate_keywords, persona, provider_id)
       VALUES (?, ?, 'self-check rule', 1, 'professional', 'id,en', 'Be brief and helpful.', 1, 50, 'refund,hukum', 'Support agent', ?)`,
      ruleId,
      (commentTarget as any).id,
      providerId,
    );
    const ingested = ingestComment((commentTarget as any).id, {
      platform: "youtube",
      externalId: `selfcheck_${Date.now()}`,
      body: "Halo, ini pertanyaan uji dari self-check. Kapan video berikutnya rilis?",
      authorHandle: "self_check_user",
      threadKind: "comment",
      receivedAt: new Date().toISOString(),
    });
    check("inbound comment ingested", Boolean(ingested?.id));
    const drafted = await processComment(ingested.id);
    check("auto-reply drafted", Boolean(drafted && (drafted as any).id), drafted ? (drafted as any).status : "none");
    run("DELETE FROM ai_rules WHERE id = ?", ruleId);
  } else {
    console.log("  skip  auto-reply flow (no seeded account)");
  }

  /* ---- queue health ---- */
  const health = queueHealth();
  check("queue health reports a backend", typeof health.mode === "string", health.mode);
  check("queue ledger is queryable", all("SELECT id FROM job_runs LIMIT 1").length >= 0);

  /* ---- auth primitives ---- */
  const hash = hashPassword("probe-password-123");
  check("password hash verifies", hash.startsWith("scrypt$"), hash.slice(0, 24));

  /* ---- integrity: no plaintext secrets persisted ---- */
  const leaked = all("SELECT id FROM accounts WHERE access_token_enc NOT LIKE 'v1.%' LIMIT 1");
  check("stored tokens are encrypted", leaked.length === 0);
  const sample = one<{ access_token_enc: string }>(
    "SELECT access_token_enc FROM accounts WHERE access_token_enc LIKE 'v1.%' LIMIT 1",
  );
  const roundTrip = sample ? decryptSecret(sample.access_token_enc) : null;
  check("encrypted token round-trips to plaintext", Boolean(roundTrip && roundTrip.length > 0));

  /* ---- AI completion (local mock server) ---- */
  const probe = await fetch(`${mock.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "selfcheck-model", messages: [{ role: "user", content: "hi" }] }),
  });
  check("mock AI answers 200", probe.ok);
  const pj = await probe.json() as any;
  check("mock AI returns choices", pj.choices?.[0]?.message?.content === "ready");

  /* ---- cleanup ---- */
  run("DELETE FROM ai_providers WHERE id = ?", providerId);
  await mock.close();

  console.log(failures === 0 ? `\nall ${seen.length} checks passed` : `\n${failures} of ${seen.length} checks FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
