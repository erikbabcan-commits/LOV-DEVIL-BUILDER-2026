CREATE TABLE IF NOT EXISTS account_closure_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  eligible_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, request_id),
  CHECK (eligible_at > requested_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= requested_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_closure_pending_owner
  ON account_closure_requests (user_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS account_closure_pending_due
  ON account_closure_requests (eligible_at, user_id) WHERE cancelled_at IS NULL;
