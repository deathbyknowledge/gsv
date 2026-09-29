CREATE TABLE installation_onboarding_claims (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE REFERENCES installations(id) ON DELETE CASCADE,
  token_prefix     TEXT NOT NULL UNIQUE,
  token_hash       TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  revoked_at       INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX installation_onboarding_expiry_idx
ON installation_onboarding_claims (expires_at, completed_at, revoked_at);
