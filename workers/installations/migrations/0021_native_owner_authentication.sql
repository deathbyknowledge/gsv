CREATE TABLE principal_email_credentials (
  email_normalized TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE owner_auth_sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  authenticated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX owner_auth_sessions_expiry ON owner_auth_sessions(expires_at);
CREATE INDEX owner_auth_sessions_principal ON owner_auth_sessions(principal_id);

CREATE TABLE owner_auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link', 'recover')),
  owner_attempt_id TEXT REFERENCES installation_owner_attempts(id) ON DELETE CASCADE,
  browser_secret_hash TEXT NOT NULL,
  code_generation TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  verification_id TEXT,
  verified_at INTEGER,
  principal_id TEXT REFERENCES principals(id),
  session_hash TEXT,
  delivery_id TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('sending', 'sent', 'failed')),
  delivery_lease_until INTEGER NOT NULL,
  sent_at INTEGER,
  CHECK ((purpose = 'login' AND owner_attempt_id IS NULL) OR (purpose != 'login' AND owner_attempt_id IS NOT NULL))
);
CREATE INDEX owner_auth_challenges_expiry ON owner_auth_challenges(expires_at);
CREATE INDEX owner_auth_challenges_owner_attempt ON owner_auth_challenges(owner_attempt_id);
CREATE INDEX owner_auth_challenges_browser ON owner_auth_challenges(browser_secret_hash, purpose, owner_attempt_id);
CREATE INDEX installation_owner_attempts_expiry ON installation_owner_attempts(expires_at);

CREATE TABLE owner_auth_send_events (
  id TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX owner_auth_send_events_email ON owner_auth_send_events(email_key, created_at);
CREATE INDEX owner_auth_send_events_ip ON owner_auth_send_events(ip_key, created_at);
CREATE INDEX owner_auth_send_events_expiry ON owner_auth_send_events(expires_at);
