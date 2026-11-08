CREATE TABLE IF NOT EXISTS private_blueprints (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id UUID NOT NULL,
  title TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  files JSONB NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count BETWEEN 1 AND 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, source_project_id, source_snapshot_id)
);
