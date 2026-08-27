-- Unduruz backend schema.
-- Run once:  psql -U unduruz -d unduruz -f db/schema.sql

CREATE TABLE IF NOT EXISTS tasks (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL,
  channel         TEXT,
  brief           TEXT,
  disclosure      JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent           TEXT NOT NULL DEFAULT 'Board',
  status          TEXT NOT NULL DEFAULT 'queued',
    -- queued -> drafting -> review -> (rework -> review)* -> approved -> published
  output          TEXT,
  review_note     TEXT,
  est_value_cents INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'auto',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);

-- Durable job queue. Postgres only: no Redis to babysit on a Pi.
CREATE TABLE IF NOT EXISTS jobs (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|running|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, run_at);

-- Real money only. Written by verified webhooks, never by an agent.
CREATE TABLE IF NOT EXISTS sales (
  id           SERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'AUD',
  email        TEXT,
  product      TEXT,
  task_id      INTEGER REFERENCES tasks(id),
  raw          JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)          -- replays cannot double-count
);

CREATE TABLE IF NOT EXISTS events (
  id         SERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  text       TEXT NOT NULL,
  icon       TEXT DEFAULT '*',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_time_idx ON events(created_at DESC);

-- Daily counters so a bug cannot run up an API bill.
CREATE TABLE IF NOT EXISTS usage_day (
  day           DATE PRIMARY KEY,
  drafts        INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0
);

-- ===== conversation memory ===========================================
-- Verbatim recent turns, plus a rolling summary so an agent can remember
-- a decision made weeks ago without replaying every message.

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  agent      TEXT NOT NULL,
  role       TEXT NOT NULL,              -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_agent_idx ON messages(agent, id DESC);

CREATE TABLE IF NOT EXISTS agent_memory (
  agent              TEXT PRIMARY KEY,
  summary            TEXT NOT NULL DEFAULT '',
  last_summarised_id INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== generated images ==============================================
CREATE TABLE IF NOT EXISTS assets (
  id         SERIAL PRIMARY KEY,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'image',
  path       TEXT NOT NULL,               -- relative to src/public
  prompt     TEXT,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(task_id);

ALTER TABLE usage_day ADD COLUMN IF NOT EXISTS images INTEGER NOT NULL DEFAULT 0;

-- ===== duplicate detection ===========================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS embedding  JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dupe_of    INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dupe_score NUMERIC(4,3);
