ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS blueprint_start_snapshot_id TEXT;
ALTER TABLE blueprint_uses ADD COLUMN IF NOT EXISTS first_published_at TIMESTAMPTZ;
