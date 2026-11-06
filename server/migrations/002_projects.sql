-- Server-owned account partition. No anonymous project storage.
CREATE TABLE IF NOT EXISTS builder_projects (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  workspace JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (owner_id, project_id)
);
-- The primary key covers owner-scoped cursor listing and all point operations.
