CREATE TABLE IF NOT EXISTS blueprint_uses (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS blueprint_uses_owner_month ON blueprint_uses(owner_id, recorded_at);
