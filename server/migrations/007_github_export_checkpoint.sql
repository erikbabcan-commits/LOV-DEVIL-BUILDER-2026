-- Server-owned recovery evidence only: repository/commit/tree/blob IDs, never
-- OAuth credentials or source content. Older jobs remain NULL (manual review).
ALTER TABLE github_exports ADD COLUMN IF NOT EXISTS checkpoint JSONB;
ALTER TABLE github_exports ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
