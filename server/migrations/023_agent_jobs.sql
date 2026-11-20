-- Durable AI agent jobs (issue #75, step 3): one row per generation run.
-- Events are appended as they happen, so a client can disconnect and later
-- poll the job instead of relying on a single long-lived SSE connection.
-- The idempotency key prevents a replayed request from running twice.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  events          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_owner_idempotency ON agent_jobs (owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_owner_created ON agent_jobs (owner_id, created_at DESC);
