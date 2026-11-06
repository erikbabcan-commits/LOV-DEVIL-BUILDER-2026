-- Hono-owned OAuth state. At most one pending connection per internal user.
-- State and browser nonce are stored only as SHA-256 digests, never as credentials.
CREATE TABLE IF NOT EXISTS github_pending (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT false,
  verifier_cipher TEXT,
  connection_cipher TEXT,
  connection_expires_at TIMESTAMPTZ
);
