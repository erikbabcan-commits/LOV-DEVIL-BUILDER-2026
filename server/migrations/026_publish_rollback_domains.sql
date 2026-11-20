-- Agent 7 (LOV-DEVIL wave 2): project slugs, custom domains and rollback support.
-- Builds on 019_publish_live_addresses (never edited). Idempotent: every
-- statement uses IF NOT EXISTS so re-running the whole migration set is safe.
-- No public DNS or registrar side effects.
--
-- Label/domain shape (length, charset, reserved names) is enforced in
-- server/publish/router.ts so pg-mem unit tests and native Postgres stay aligned
-- without depending on char_length / POSIX regex in CHECK constraints.

CREATE TABLE IF NOT EXISTS publish_project_slugs (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, project_id),
  UNIQUE (slug),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES builder_projects(owner_id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS publish_custom_domains (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'verified')),
  verification_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  PRIMARY KEY (domain),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES builder_projects(owner_id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS publish_custom_domains_project
  ON publish_custom_domains(owner_id, project_id);

CREATE INDEX IF NOT EXISTS publish_custom_domains_status
  ON publish_custom_domains(status);

-- Rollback (manual, not run by the migrator):
--   DROP INDEX IF EXISTS publish_custom_domains_status;
--   DROP INDEX IF EXISTS publish_custom_domains_project;
--   DROP TABLE IF EXISTS publish_custom_domains;
--   DROP TABLE IF EXISTS publish_project_slugs;
