-- 001_init.sql: core schema for SocialDeck
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator', -- owner | admin | operator | analyst
  locale        TEXT NOT NULL DEFAULT 'id-ID',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Per-platform OAuth application credentials (one row per platform, or per tenant app)
CREATE TABLE IF NOT EXISTS oauth_apps (
  id                TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  redirect_uri      TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '',
  extra_json        TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform)
);

-- Connected social accounts
CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  platform          TEXT NOT NULL, -- facebook | instagram | tiktok | youtube | x | threads | linkedin | pinterest | mastodon
  external_id       TEXT NOT NULL,
  handle            TEXT,
  display_name      TEXT,
  avatar_url        TEXT,
  account_type      TEXT NOT NULL DEFAULT 'page', -- page | profile | channel | business | board
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  token_expires_at  TEXT,
  scopes            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'connected', -- connected | expired | revoked | error
  last_error        TEXT,
  meta_json         TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform, status);

CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  duration_s REAL,
  rel_path   TEXT NOT NULL,
  sha256     TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Publishing queue entities
CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'text', -- text | image | video | short | reel | story
  body           TEXT NOT NULL DEFAULT '',
  title          TEXT,
  media_json     TEXT NOT NULL DEFAULT '[]', -- [{mediaId, alt, position}]
  link_url       TEXT,
  scheduled_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | queued | publishing | published | failed | cancelled
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  external_id    TEXT,
  permalink      TEXT,
  metrics_json   TEXT NOT NULL DEFAULT '{}',
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  campaign       TEXT,
  approved_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id, created_at DESC);

-- Inbound engagement: comments, mentions, DMs
CREATE TABLE IF NOT EXISTS comments (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  parent_external_id TEXT,
  thread_kind       TEXT NOT NULL DEFAULT 'comment', -- comment | mention | dm | review
  post_external_id  TEXT,
  author_handle     TEXT,
  author_name       TEXT,
  body              TEXT NOT NULL DEFAULT '',
  sentiment         REAL,              -- -1.0 .. 1.0
  intent            TEXT,              -- question | praise | complaint | spam | other
  language          TEXT,
  risk             TEXT NOT NULL DEFAULT 'none', -- none | sensitive | crisis | spam
  received_at       TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json          TEXT NOT NULL DEFAULT '{}',
  UNIQUE(platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_account ON comments(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_risk ON comments(risk, received_at DESC);

CREATE TABLE IF NOT EXISTS replies (
  id            TEXT PRIMARY KEY,
  comment_id    TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'auto', -- auto | suggested | manual | escalate
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | sent | failed | blocked | rejected
  provider_id   TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  model         TEXT,
  confidence    REAL,
  external_id   TEXT,
  error         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status, created_at DESC);

-- Configurable AI backends: external APIs or local routers/servers
CREATE TABLE IF NOT EXISTS ai_providers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL, -- openai | anthropic | openai-compatible | ollama | lmstudio | router | custom
  base_url      TEXT NOT NULL,
  model         TEXT NOT NULL,
  api_key_enc   TEXT,
  extra_json    TEXT NOT NULL DEFAULT '{}',
  temperature   REAL NOT NULL DEFAULT 0.4,
  max_tokens    INTEGER NOT NULL DEFAULT 800,
  timeout_ms    INTEGER NOT NULL DEFAULT 60000,
  enabled       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_rules (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT REFERENCES accounts(id) ON DELETE CASCADE, -- null = global
  name                TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  tone                TEXT NOT NULL DEFAULT 'professional',
  languages           TEXT NOT NULL DEFAULT 'id,en',
  system_prompt       TEXT NOT NULL DEFAULT '',
  provider_id         TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  auto_send           INTEGER NOT NULL DEFAULT 0,       -- 0 = human approval queue
  delay_seconds       INTEGER NOT NULL DEFAULT 45,
  max_per_hour        INTEGER NOT NULL DEFAULT 12,
  sentiment_floor     REAL NOT NULL DEFAULT -0.5,        -- below this: never auto-reply
  escalate_keywords   TEXT NOT NULL DEFAULT 'refund,hukum,legal,polisi,bpom,pengacara',
  blocked_topics      TEXT NOT NULL DEFAULT '',
  quiet_hours         TEXT NOT NULL DEFAULT '22:00-06:00',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- RTMP relay: loop pre-recorded video to a platform ingest endpoint
CREATE TABLE IF NOT EXISTS streams (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  platform       TEXT NOT NULL,
  rtmp_url       TEXT NOT NULL,
  stream_key_enc TEXT NOT NULL,
  playlist_json  TEXT NOT NULL DEFAULT '[]', -- [{mediaId, durationS, fallbackText}]
  bitrate_kbps   INTEGER NOT NULL DEFAULT 3500,
  resolution     TEXT NOT NULL DEFAULT '1920x1080',
  fps            INTEGER NOT NULL DEFAULT 30,
  loop_forever   INTEGER NOT NULL DEFAULT 1,
  state          TEXT NOT NULL DEFAULT 'idle', -- idle | starting | live | stopping | error
  ffmpeg_pid     INTEGER,
  started_at     TEXT,
  stopped_at     TEXT,
  uptime_s       INTEGER NOT NULL DEFAULT 0,
  restart_count  INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_streams_state ON streams(state);

CREATE TABLE IF NOT EXISTS stream_events (
  id        TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  level     TEXT NOT NULL DEFAULT 'info',
  message   TEXT NOT NULL,
  ts        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stream_events ON stream_events(stream_id, ts DESC);

-- Webhook inbox (idempotent ingest)
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  topic        TEXT,
  account_id   TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  signature_ok INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_unprocessed ON webhook_events(processed_at, received_at);

-- Queue ledger: mirrors BullMQ state so the UI works on SQL alone
CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  queue        TEXT NOT NULL,
  job_name     TEXT NOT NULL,
  ref_table    TEXT,
  ref_id       TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'queued', -- queued | active | completed | failed | delayed | stalled
  attempts     INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobruns_queue ON job_runs(queue, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day              TEXT NOT NULL,
  followers        INTEGER NOT NULL DEFAULT 0,
  impressions      INTEGER NOT NULL DEFAULT 0,
  engagements      INTEGER NOT NULL DEFAULT 0,
  posts_published  INTEGER NOT NULL DEFAULT 0,
  comments_in      INTEGER NOT NULL DEFAULT 0,
  replies_sent     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, day)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  actor      TEXT,          -- user id, 'system', 'agent'
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
