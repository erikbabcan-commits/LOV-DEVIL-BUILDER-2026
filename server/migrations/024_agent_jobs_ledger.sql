-- Agent 1 (LOV-DEVIL wave 1): durable job queue + quota ledger.
-- Builds on 023_agent_jobs.sql (never edited). Idempotent: every statement is
-- IF NOT EXISTS, so re-running the whole migration set is safe.
--
-- agent_jobs gets the data a worker needs to (re)run a job after a restart and
-- the detail fields of the AgentJobDetail contract (shared/agentJobs.ts, part B).
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS request       JSONB;       -- validated GenerateRequest, NULL for legacy SSE jobs and once terminal
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS attempts      INT NOT NULL DEFAULT 0;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS tokens_input  INT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS tokens_output INT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS result_patch  JSONB;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS error_payload JSONB;
CREATE INDEX IF NOT EXISTS idx_agent_jobs_state_created ON agent_jobs (state, created_at);

-- Append-only quota ledger: one row per job that reached `succeeded` and was
-- debited. PRIMARY KEY (job_id) makes a second debit for the same job
-- impossible. Rows are inserted in the same transaction as the
-- running -> succeeded transition and the user_quotas increment (see
-- PostgresAgentJobStore.completeSucceeded). The application never UPDATEs or
-- DELETEs them (rows disappear only via ON DELETE CASCADE on account closure).
CREATE TABLE IF NOT EXISTS agent_job_ledger (
  job_id       TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  units        INT NOT NULL DEFAULT 1 CHECK (units = 1),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_job_ledger_owner_period ON agent_job_ledger (owner_id, period_start);

-- Rollback (manual, not run by the migrator):
--   DROP TABLE IF EXISTS agent_job_ledger;
--   ALTER TABLE agent_jobs DROP COLUMN IF EXISTS request, DROP COLUMN IF EXISTS attempts,
--     DROP COLUMN IF EXISTS tokens_input, DROP COLUMN IF EXISTS tokens_output,
--     DROP COLUMN IF EXISTS result_patch, DROP COLUMN IF EXISTS error_payload;
--   DROP INDEX IF EXISTS idx_agent_jobs_state_created;
