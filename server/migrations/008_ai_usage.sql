-- Source-free AI accounting. Prepared calls are deliberately retained when a
-- process dies or provider usage is unknown. They must never become zero cost.
CREATE TABLE IF NOT EXISTS ai_runs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('generation','autofix')),
  period_start DATE NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free','pro')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled','incomplete')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  call_count INT NOT NULL DEFAULT 0 CHECK (call_count BETWEEN 0 AND 128),
  PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS ai_calls (
  user_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  call_no INT NOT NULL CHECK (call_no BETWEEN 1 AND 128),
  provider VARCHAR(128) NOT NULL CHECK (provider <> ''),
  requested_model VARCHAR(128) NOT NULL CHECK (requested_model <> ''),
  actual_model VARCHAR(128) CHECK (actual_model <> ''),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','completed','failed','cancelled','not_sent')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  prompt_tokens BIGINT CHECK (prompt_tokens BETWEEN 0 AND 1000000000),
  completion_tokens BIGINT CHECK (completion_tokens BETWEEN 0 AND 1000000000),
  CHECK ((prompt_tokens IS NULL) = (completion_tokens IS NULL)),
  PRIMARY KEY(user_id,run_id,call_no),
  FOREIGN KEY(user_id,run_id) REFERENCES ai_runs(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ai_runs_owner_month ON ai_runs(user_id,started_at);
CREATE INDEX IF NOT EXISTS ai_calls_owner_month ON ai_calls(user_id,started_at);
