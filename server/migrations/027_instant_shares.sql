-- 027_instant_shares.sql
-- 1-Click Instant Shareable Link (Verejný náhľad pre klientov bez nutnosti prihlasovania)
CREATE TABLE IF NOT EXISTS public_instant_shares (
  share_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  views_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_public_instant_shares_project ON public_instant_shares(project_id);
