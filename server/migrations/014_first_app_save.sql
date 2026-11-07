-- First qualifying save observed after this migration. Existing histories
-- contain no trustworthy first-save timestamp, so leave old accounts unset.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_observed_app_save_at TIMESTAMPTZ;
