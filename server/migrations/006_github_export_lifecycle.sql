-- Keep request-id tombstones: an old confirmation must never re-arm a write.
-- Only proposals that never started writing may release a repository name.
ALTER TABLE github_exports DROP CONSTRAINT IF EXISTS github_exports_status_check;
ALTER TABLE github_exports ADD CONSTRAINT github_exports_status_check
  CHECK (status IN ('prepared','running','succeeded','failed','cancelled','expired'));
ALTER TABLE github_exports DROP CONSTRAINT IF EXISTS github_exports_owner_id_repo_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS github_exports_reserved_name
  ON github_exports(owner_id, repo_name)
  WHERE status IN ('prepared','running','succeeded','failed');
