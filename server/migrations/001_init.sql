-- WS-1: users, trvalé kvóty (monthly window), plány
-- ID generuje aplikácia (crypto.randomUUID) — prenositeľné aj do pg-mem

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kmeňovo jednoduché dátové kvóty: jeden riadok na usera, mesačne okno;
-- inkrement je atomic — pozri server/security/quotaStore.ts.
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  generations  INT NOT NULL DEFAULT 0 CHECK (generations >= 0)
);

-- Audit register prihlásení (GDPR minimálny základ — dátum, IP nie).
CREATE TABLE IF NOT EXISTS auth_log (
  id        TEXT PRIMARY KEY,
  user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  action    TEXT NOT NULL CHECK (action IN ('register', 'login', 'login_failed', 'logout')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_quotas_period ON user_quotas (user_id, period_start);
CREATE INDEX IF NOT EXISTS idx_auth_log_user ON auth_log (user_id, created_at DESC);
