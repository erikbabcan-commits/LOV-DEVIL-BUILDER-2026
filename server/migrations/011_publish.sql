CREATE TABLE IF NOT EXISTS publish_jobs (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL CHECK(project_revision > 0),
  snapshot_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  source_files JSONB NOT NULL,
  artifact_id UUID NOT NULL UNIQUE,
  artifact_sha256 TEXT,
  artifact_bytes INTEGER,
  state TEXT NOT NULL CHECK(state IN ('building','published','failed')),
  error_code TEXT,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS publish_jobs_owner_state ON publish_jobs(owner_id,state);
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS claim_id UUID;
