-- Immutable content-addressed operator policies. No default/published prices.
CREATE TABLE IF NOT EXISTS ai_price_policies (
  fingerprint VARCHAR(64) PRIMARY KEY,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_call_costs (
  user_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  call_no INT NOT NULL,
  policy_fingerprint VARCHAR(64) REFERENCES ai_price_policies(fingerprint),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','priced','unpriced','not_sent')),
  reason TEXT CHECK (reason IN ('no_policy','unknown_usage','model_missing','no_effective_rate','not_sent')),
  estimated_cost_microusd BIGINT CHECK (estimated_cost_microusd BETWEEN 0 AND 9007199254740991),
  rate_index INT CHECK (rate_index BETWEEN 0 AND 127),
  CHECK ((status='priced' AND estimated_cost_microusd IS NOT NULL AND rate_index IS NOT NULL AND policy_fingerprint IS NOT NULL AND reason IS NULL)
    OR (status='pending' AND estimated_cost_microusd IS NULL AND rate_index IS NULL AND reason IS NULL)
    OR (status='unpriced' AND estimated_cost_microusd IS NULL AND rate_index IS NULL AND reason IS NOT NULL AND reason IN ('no_policy','unknown_usage','model_missing','no_effective_rate'))
    OR (status='not_sent' AND estimated_cost_microusd IS NULL AND rate_index IS NULL AND reason IS NOT NULL AND reason='not_sent')),
  PRIMARY KEY(user_id,run_id,call_no),
  FOREIGN KEY(user_id,run_id,call_no) REFERENCES ai_calls(user_id,run_id,call_no) ON DELETE CASCADE
);

-- Global month reports need a time-leading index; owner reads retain the v008 index.
CREATE INDEX IF NOT EXISTS ai_calls_month_owner ON ai_calls(started_at,user_id);
