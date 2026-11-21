-- Agent 5: durable Stripe webhook queue, ordering guard and payment grace period.
-- Idempotency stays in billing_events (one row per processed Stripe event id).
-- The queue stores only normalized, signature-verified event fields; never raw
-- payloads or provider credentials. Rows are never deleted by the application.
CREATE TABLE IF NOT EXISTS billing_webhook_queue (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_created BIGINT,
  customer_id TEXT NOT NULL,
  checkout_session_id TEXT,
  positive_invoice_subscription_id TEXT,
  positive_invoice_paid_at BIGINT,
  livemode BOOLEAN NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','failed','dead')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('applied','duplicate','stale')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INT NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS billing_webhook_queue_due ON billing_webhook_queue(state,next_attempt_at);
CREATE INDEX IF NOT EXISTS billing_webhook_queue_owner ON billing_webhook_queue(user_id,received_at);

-- Per-account billing lifecycle beside billing_accounts (no edits to 010).
-- last_subscription_event_created: newest applied customer.subscription.* event
-- (Stripe "created", epoch seconds); older deliveries never move it back.
-- Downgrade after an expired grace period is only a flag plus users.plan='free'.
CREATE TABLE IF NOT EXISTS billing_account_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_subscription_event_created BIGINT,
  last_subscription_event_id TEXT,
  payment_failed_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,
  grace_resolved_at TIMESTAMPTZ,
  downgraded_to_free_at TIMESTAMPTZ,
  downgrade_reason TEXT CHECK (downgrade_reason IS NULL OR downgrade_reason IN ('grace_period_expired','subscription_ended')),
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_account_state_grace ON billing_account_state(grace_period_ends_at);
