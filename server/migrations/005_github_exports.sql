-- Durable publication ledger; never automatically retry a running/failed write.
-- No OAuth tokens, source content or secrets are stored in the ledger.
CREATE TABLE IF NOT EXISTS github_exports (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  github_username TEXT NOT NULL,
  selection JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  connection_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CONSTRAINT github_exports_status_check CHECK (status IN ('prepared','running','succeeded','failed')),
  result JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, request_id),
  CONSTRAINT github_exports_owner_id_repo_name_key UNIQUE (owner_id, repo_name)
);
