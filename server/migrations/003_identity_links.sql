-- Operator-managed bindings to a single, verified Cloud Auth issuer.
-- No automatic matching by email; existing accounts retain their projects and quotas.
CREATE TABLE IF NOT EXISTS identity_links (
  issuer     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, user_id)
);
