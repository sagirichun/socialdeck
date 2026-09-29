#!/usr/bin/env tsx
/**
 * Seeds a realistic operations dataset so the dashboard renders with content and the
 * check script can assert against known rows. Safe to re-run: it clears the demo tenant first.
 */
import crypto from "node:crypto";
import "../src/lib/platforms";
import { all, migrate, one, run, uid, tx } from "../src/lib/db";
import { encryptSecret, hashPassword } from "../src/lib/crypto";

migrate();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@socialdeck.local";
// Demo seeder: passwords are generated per run and printed once at the end. Never ship a
// fixed credential in a public repo — anyone could log into a deployment seeded this way.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
const ANALYST_PASSWORD = process.env.SEED_ANALYST_PASSWORD || crypto.randomBytes(12).toString("base64url");

tx(() => {
  for (const table of [
    "agent_steps",
    "agent_runs",
    "reply_exemplars",
    "replies",
    "comments",
    "webhook_events",
    "job_runs",
    "analytics_daily",
    "stream_events",
    "streams",
    "posts",
    "media",
    "ai_rules",
    "oauth_apps",
    "accounts",
    "sessions",
    "audit_logs",
    "ai_providers",
    "users",
  ]) {
    run(`DELETE FROM ${table}`);
  }
});

const users = [
  { email: ADMIN_EMAIL, name: "Operations Lead", role: "owner", password: ADMIN_PASSWORD },
  { email: "analyst@socialdeck.local", name: "Insight Analyst", role: "analyst", password: ANALYST_PASSWORD },
];
for (const u of users) {
  run(
    "INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    uid("usr"),
    u.email,
    u.name,
    hashPassword(u.password),
    u.role,
  );
}
const analystId = one<{ id: string }>("SELECT id FROM users WHERE role = 'analyst'")!.id;

/* AI providers: one external API, one local router. Both use the same adapter interface. */
const externalProvider = uid("aip");
run(
  `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key_enc, temperature, max_tokens, enabled, is_default, extra_json)
   VALUES (?, ?, 'openai', 'https://api.openai.com/v1', 'gpt-4o-mini', NULL, 0.4, 800, 1, 1, '{}')`,
  externalProvider,
  "OpenAI production",
);
const localProvider = uid("aip");
run(
  `INSERT INTO ai_providers (id, name, kind, base_url, model, temperature, max_tokens, enabled, is_default, extra_json)
   VALUES (?, ?, 'ollama', 'http://127.0.0.1:11434', 'llama3.1:8b', 0.3, 800, 1, 0, '{}')`,
  localProvider,
  "On-prem Ollama",
);
const routerProvider = uid("aip");
run(
  `INSERT INTO ai_providers (id, name, kind, base_url, model, api_key_enc, temperature, max_tokens, enabled, is_default, extra_json)
   VALUES (?, ?, 'router', 'http://127.0.0.1:8081/v1', 'brsk/auto', ?, 0.4, 800, 1, 0, '{}')`,
  routerProvider,
  "Internal model router",
  encryptSecret("local-dev-key"),
);

/* Accounts across the supported networks. */
const accountSpecs = [
  { platform: "facebook", external: "1029384756", handle: "Northwind Retail", type: "page", followers: 48210 },
  { platform: "instagram", external: "17841400000000001", handle: "northwind.retail", type: "business", followers: 63980 },
  { platform: "tiktok", external: "open_id_8812", handle: "northwind", type: "business", followers: 24150 },
  { platform: "youtube", external: "UC_northwind_channel", handle: "@northwind", type: "channel", followers: 18740 },
  { platform: "x", external: "1488129034", handle: "northwind", type: "profile", followers: 9280 },
  { platform: "threads", external: "5566778899", handle: "northwind", type: "profile", followers: 5120 },
  { platform: "linkedin", external: "li_99231", handle: "northwind-retail", type: "profile", followers: 12460 },
];
const accountIds: Record<string, string> = {};
for (const spec of accountSpecs) {
  const id = uid("acc");
  accountIds[spec.platform] = id;
  run(
    `INSERT INTO accounts (id, platform, external_id, handle, display_name, account_type, access_token_enc,
       token_expires_at, scopes, status, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+30 day'), ?, 'connected', ?)`,
    id,
    spec.platform,
    spec.external,
    spec.handle,
    spec.handle,
    spec.type,
    encryptSecret(`demo-token-${spec.platform}`),
    spec.platform === "x" ? "tweet.write users.read" : "read write",
    JSON.stringify({ privacyStatus: spec.platform === "youtube" ? "private" : undefined, privacyLevel: spec.platform === "tiktok" ? "SELF_ONLY" : undefined }),
  );
}

/* Analytics history so trends render. */
for (const spec of accountSpecs) {
  for (let d = 13; d >= 0; d--) {
    const base = spec.followers;
    const drift = Math.round(base * (0.02 * (14 - d) / 14));
    const followers = base - Math.round(base * 0.02) + drift;
    run(
      `INSERT INTO analytics_daily (id, account_id, day, followers, impressions, engagements, posts_published, comments_in, replies_sent)
       VALUES (?, ?, date('now', ?), ?, ?, ?, ?, ?, ?)`,
      uid("anl"),
      accountIds[spec.platform],
      `-${d} day`,
      followers,
      Math.round(base * (3 + Math.random() * 4)),
      Math.round(base * (0.1 + Math.random() * 0.4)),
      Math.round(Math.random() * 4),
      Math.round(Math.random() * 60),
      Math.round(Math.random() * 40),
    );
  }
}

/* Media placeholders (files are generated by scripts/check.ts on demand). */
const mediaIds: string[] = [];
const mediaSpecs = [
  { filename: "q1-product-reel.mp4", mime: "video/mp4", w: 1080, h: 1920, dur: 42.5 },
  { filename: "storefront-loop.mp4", mime: "video/mp4", w: 1920, h: 1080, dur: 180.0 },
  { filename: "spring-lookbook.mp4", mime: "video/mp4", w: 1920, h: 1080, dur: 96.0 },
  { filename: "campaign-keyvisual.jpg", mime: "image/jpeg", w: 2048, h: 1152, dur: null },
];
for (const m of mediaSpecs) {
  const id = uid("med");
  mediaIds.push(id);
  run(
    `INSERT INTO media (id, filename, mime, bytes, width, height, duration_s, rel_path, sha256, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    id,
    m.filename,
    m.mime,
    1024 * 1024 * 4,
    m.w,
    m.h,
    m.dur,
    `uploads/${id}${m.mime === "image/jpeg" ? ".jpg" : ".mp4"}`,
    analystId,
  );
}

/* Posts across every lifecycle state. */
const postSpecs = [
  { platform: "instagram", kind: "reel", status: "published", body: "Behind the counter: how the spring collection gets assembled before opening hours.", days: -3, media: [0] },
  { platform: "facebook", kind: "image", status: "published", body: "Store pickup now runs until 21:00 on weekdays.", days: -2, media: [3] },
  { platform: "x", kind: "text", status: "published", body: "Restock alert: the linen overshirt is back in every size.", days: -1, media: [] },
  { platform: "youtube", kind: "video", status: "scheduled", body: "Full store walkthrough and the three pieces flying off the shelves this week.", days: 1, media: [2] },
  { platform: "tiktok", kind: "video", status: "scheduled", body: "Sixty seconds, one outfit, three ways.", days: 2, media: [0] },
  { platform: "threads", kind: "text", status: "queued", body: "Question for the regulars: which fabric do you want us to bring back next season?", days: 0, media: [] },
  { platform: "linkedin", kind: "image", status: "draft", body: "We are opening a second fulfilment hub in Q3. Here is what that means for delivery times.", days: null, media: [3] },
  { platform: "instagram", kind: "image", status: "failed", body: "Weekend promo board.", days: -1, media: [3], error: "instagram container rate limit: try again in 600s" },
];
let mediaCursor = 0;
for (const spec of postSpecs) {
  const id = uid("pst");
  const attached = spec.media.map((idx) => ({ mediaId: mediaIds[idx] }));
  run(
    `INSERT INTO posts (id, account_id, kind, body, media_json, scheduled_at, status, attempts, last_error, external_id, permalink, campaign, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ${spec.days === null ? "NULL" : "datetime('now', ?)"}, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    id,
    accountIds[spec.platform],
    spec.kind,
    spec.body,
    JSON.stringify(attached),
    ...(spec.days === null ? [] : [`${spec.days} day`]),
    spec.status,
    spec.status === "failed" ? 3 : 0,
    spec.error ?? null,
    spec.status === "published" ? `ext_${id}` : null,
    spec.status === "published" ? `https://example.com/p/${id}` : null,
    spec.platform === "instagram" ? "Spring collection" : "Always-on",
    analystId,
  );
  mediaCursor++;
}

/* AI rules: one global, one account-specific with auto-send enabled. */
run(
  `INSERT INTO ai_rules (id, account_id, name, enabled, tone, languages, system_prompt, provider_id, auto_send,
     delay_seconds, max_per_hour, sentiment_floor, escalate_keywords, blocked_topics, quiet_hours)
   VALUES (?, NULL, 'Global brand voice', 1, 'warm, factual, never salesy', 'id,en',
     'Brand guidance: we are a retail chain with 42 stores. Support handles orders at support@northwind.example. Never discuss pricing errors; route them to support.',
     ?, 0, 45, 12, -0.5, 'refund,hukum,legal,polisi,pengacara,bpom', 'penipuan,scam', '22:00-06:00')`,
  uid("rul"),
  externalProvider,
);
run(
  `INSERT INTO ai_rules (id, account_id, name, enabled, tone, languages, system_prompt, provider_id, auto_send,
     delay_seconds, max_per_hour, sentiment_floor, escalate_keywords, blocked_topics, quiet_hours)
   VALUES (?, ?, 'Instagram fast lane', 1, 'short, friendly, emoji-free', 'id,en',
     'Answers must be under 220 characters. Link the size guide when someone asks about fit.',
     ?, 1, 30, 20, -0.4, 'refund,hukum,legal', 'penipuan', '23:00-05:00')`,
  uid("rul"),
  accountIds.instagram,
  localProvider,
);

/* Inbound messages with a mix of classifications and reply states. */
const commentSpecs = [
  { platform: "instagram", author: "dinda.k", body: "Kak, ukuran L masih ada? Mau checkout hari ini.", sentiment: 0.4, intent: "question", risk: "none", reply: { status: "pending", body: "Halo, ukuran L masih tersedia di gudang pusat dan siap dikirim hari ini. Silakan checkout melalui tautan di bio ya." } },
  { platform: "instagram", author: "rendra_w", body: "Pengiriman ke Surabaya biasanya berapa hari?", sentiment: 0.1, intent: "question", risk: "none", reply: { status: "sent", body: "Untuk Surabaya rata-rata dua sampai tiga hari kerja setelah pembayaran dikonfirmasi." } },
  { platform: "facebook", author: "Sri Wahyuni", body: "Produk yang saya terima rusak, saya minta refund sekarang.", sentiment: -0.7, intent: "complaint", risk: "sensitive", reply: { status: "blocked", body: "" } },
  { platform: "x", author: "arifm", body: "Kualitas jahitan jauh lebih bagus dari tahun lalu, mantap.", sentiment: 0.8, intent: "praise", risk: "none", reply: null },
  { platform: "tiktok", author: "user88213", body: "PROMO MURAH KLIK LINK DI BIO", sentiment: -0.2, intent: "spam", risk: "spam", reply: { status: "rejected", body: "" } },
  { platform: "threads", author: "bella", body: "Apakah bisa tukar ukuran kalau tidak pas?", sentiment: 0.0, intent: "question", risk: "none", reply: { status: "pending", body: "Bisa, penukaran ukuran gratis dalam 14 hari selama label belum dilepas." } },
  { platform: "youtube", author: "Adi Prakoso", body: "Menit 04:12 itu rak bagian mana ya?", sentiment: 0.3, intent: "question", risk: "none", reply: null },
  { platform: "linkedin", author: "Rina Puspita", body: "Legal tim kami ingin meninjau klausul kemitraan sebelum tanda tangan.", sentiment: 0.0, intent: "other", risk: "crisis", reply: { status: "blocked", body: "" } },
];
for (const spec of commentSpecs) {
  const cid = uid("cmt");
  run(
    `INSERT INTO comments (id, account_id, platform, external_id, thread_kind, post_external_id, author_handle,
       author_name, body, sentiment, intent, language, risk, received_at)
     VALUES (?, ?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, 'id', ?, datetime('now', ?))`,
    cid,
    accountIds[spec.platform],
    spec.platform,
    `c_${uid("")}`,
    `post_${uid("")}`,
    spec.author,
    spec.author,
    spec.body,
    spec.sentiment,
    spec.intent,
    spec.risk,
    `-${Math.floor(Math.random() * 40) + 1} hour`,
  );
  if (spec.reply) {
    run(
      `INSERT INTO replies (id, comment_id, account_id, mode, body, status, provider_id, model, confidence, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${spec.reply.status === "sent" ? "datetime('now','-2 hour')" : "NULL"}, datetime('now', ?))`,
      uid("rep"),
      cid,
      accountIds[spec.platform],
      spec.reply.status === "sent" ? "auto" : "suggested",
      spec.reply.body,
      spec.reply.status,
      externalProvider,
      "gpt-4o-mini",
      0.72,
      `-${Math.floor(Math.random() * 30) + 1} hour`,
    );
  }
}

/* Exemplars teach the reply style per account. */
run(
  `INSERT INTO reply_exemplars (id, account_id, intent, inbound, outbound, score)
   VALUES (?, ?, 'question', ?, ?, 1)`,
  uid("exm"),
  accountIds.instagram,
  "Kak, ukuran L masih ada?",
  "Halo, ukuran L masih tersedia dan siap dikirim hari ini.",
);

/* One configured 24/7 relay plus its event history. */
const streamId = uid("stm");
run(
  `INSERT INTO streams (id, account_id, name, platform, rtmp_url, stream_key_enc, playlist_json, bitrate_kbps,
     resolution, fps, loop_forever, state, uptime_s, created_by, started_at)
   VALUES (?, ?, ?, 'youtube', 'rtmp://a.rtmp.youtube.com/live2', ?, ?, 4000, '1920x1080', 30, 1, 'live', 18420, ?, datetime('now','-5 hour'))`,
  streamId,
  accountIds.youtube,
  "Storefront 24/7 loop",
  encryptSecret("demo-stream-key-1234"),
  JSON.stringify([
    { mediaId: mediaIds[1], label: "Storefront loop", durationS: 180 },
    { mediaId: mediaIds[2], label: "Spring lookbook", durationS: 96 },
  ]),
  analystId,
);
for (const ev of [
  { level: "info", message: "relay live, ffmpeg pid 41203", hours: -5 },
  { level: "warning", message: "restart attempt 1 in 5s", hours: -3 },
  { level: "info", message: "ingest test: exit=0", hours: -1 },
]) {
  run(
    "INSERT INTO stream_events (id, stream_id, level, message, ts) VALUES (?, ?, ?, ?, datetime('now', ?))",
    uid("sev"),
    streamId,
    ev.level,
    ev.message,
    `${ev.hours} hour`,
  );
}

/* Job ledger history so the queue panel has content. */
for (const q of ["sd.publish", "sd.reply", "sd.stream", "sd.metrics"]) {
  for (let i = 0; i < 6; i++) {
    const state = i === 0 ? "active" : i === 1 ? "failed" : "completed";
    run(
      `INSERT INTO job_runs (id, queue, job_name, ref_table, ref_id, payload_json, state, attempts, created_at, started_at, finished_at, error)
       VALUES (?, ?, ?, 'posts', ?, '{}', ?, 1, datetime('now', ?), datetime('now', ?), ${state === "completed" ? "datetime('now','-1 minute')" : "NULL"}, ?)`,
      uid("job"),
      q,
      q === "sd.reply" ? "process-comment" : q === "sd.publish" ? "publish-post" : q === "sd.stream" ? "start-stream" : "sync-account",
      uid(""),
      state,
      `-${i * 7 + 2} minute`,
      `-${i * 7 + 1} minute`,
      state === "failed" ? "platform returned 429 rate limited" : null,
    );
  }
}

run(
  `INSERT INTO settings (key, value) VALUES ('brand.name', 'Northwind Retail')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

console.log("seed complete");
console.log(`  admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
console.log(`  accounts: ${accountSpecs.length}, media: ${mediaIds.length}, comments: ${commentSpecs.length}`);
