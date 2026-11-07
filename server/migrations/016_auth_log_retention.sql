CREATE INDEX IF NOT EXISTS idx_auth_log_retention ON auth_log (created_at, id);
