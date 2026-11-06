-- Never reuse a test installation's customer/session/entitlement state in live mode.
-- Fresh installations claim a mode atomically at startup; pre-pin WS-18 accounts
-- are recognized as test by initializeBillingEnvironment.
CREATE TABLE IF NOT EXISTS billing_environment (
  id TEXT PRIMARY KEY CHECK (id = 'stripe'),
  mode TEXT NOT NULL CHECK (mode IN ('test','live'))
);
