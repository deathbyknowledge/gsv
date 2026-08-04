ALTER TABLE sessions
ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'email_verification'
CHECK (auth_method IN ('email_verification', 'passkey', 'recovery'));

ALTER TABLE credentials
ADD COLUMN last_use_nonce TEXT;

ALTER TABLE login_handoffs
ADD COLUMN use_nonce TEXT;

CREATE TABLE webauthn_challenges (
  id              TEXT PRIMARY KEY,
  principal_id    TEXT REFERENCES principals(id) ON DELETE CASCADE,
  session_id_hash TEXT REFERENCES sessions(id_hash) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER,
  use_nonce       TEXT,
  CHECK (
    (kind = 'registration' AND principal_id IS NOT NULL AND session_id_hash IS NOT NULL)
    OR (kind = 'authentication' AND session_id_hash IS NULL)
  ),
  CHECK ((used_at IS NULL) = (use_nonce IS NULL))
);

CREATE INDEX webauthn_challenges_expiry_idx
ON webauthn_challenges (expires_at, used_at);

CREATE INDEX webauthn_challenges_principal_idx
ON webauthn_challenges (principal_id, kind, created_at DESC);

CREATE TABLE recovery_code_sets (
  principal_id    TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  generation      INTEGER NOT NULL,
  generation_nonce TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX rate_limit_buckets_expiry_idx
ON rate_limit_buckets (expires_at);
