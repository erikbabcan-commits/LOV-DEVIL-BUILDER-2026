-- Local Stripe subscription foundation. No provider credentials or raw webhook payloads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_id TEXT UNIQUE,
  customer_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  trial_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  has_open_subscription BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_id TEXT,
  subscription_status TEXT,
  subscription_interval TEXT CHECK (subscription_interval IS NULL OR subscription_interval IN ('month','year')),
  period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE
);
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS has_open_subscription BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interval_name TEXT NOT NULL CHECK (interval_name IN ('month','year')),
  config_fingerprint TEXT NOT NULL,
  trial_days INT CHECK (trial_days IS NULL OR trial_days = 14),
  created_at TIMESTAMPTZ NOT NULL,
  requested_expires_at BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','ready','expired','complete')),
  session_id TEXT UNIQUE,
  session_url TEXT,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS billing_checkout_owner ON billing_checkout_attempts(user_id,created_at);
CREATE TABLE IF NOT EXISTS billing_portal_attempts (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  session_url TEXT
);
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL
);
