-- 002_agent.sql: autonomous operations copilot (plan / act / observe on the same tools the UI uses)
CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running', -- running | completed | failed | cancelled | awaiting_approval
  autonomy     TEXT NOT NULL DEFAULT 'supervised', -- suggest | supervised | autonomous
  provider_id  TEXT REFERENCES ai_providers(id) ON DELETE SET NULL,
  plan_json    TEXT NOT NULL DEFAULT '[]',
  summary      TEXT,
  steps_taken  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  thought     TEXT,
  tool        TEXT,
  args_json   TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | ok | error | blocked
  requires_approval INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_steps ON agent_steps(run_id, idx);

-- Self-learning reply memory: accepted replies become few-shot exemplars per account
CREATE TABLE IF NOT EXISTS reply_exemplars (
  id          TEXT PRIMARY KEY,
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  intent      TEXT,
  inbound     TEXT NOT NULL,
  outbound    TEXT NOT NULL,
  score       INTEGER NOT NULL DEFAULT 1, -- +1 accepted, -1 rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
