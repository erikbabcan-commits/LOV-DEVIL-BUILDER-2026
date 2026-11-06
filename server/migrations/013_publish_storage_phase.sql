-- Unknown pre-protocol jobs cannot be automatically freed: a file/temp may exist.
-- New jobs explicitly enter compiling with a durable upper byte reservation.
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS storage_phase TEXT NOT NULL
  DEFAULT 'legacy_unknown' CHECK (storage_phase IN
    ('legacy_unknown','compiling','writing','retained','empty'));
