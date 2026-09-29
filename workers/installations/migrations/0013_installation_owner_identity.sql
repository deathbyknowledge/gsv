CREATE TABLE principal_external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject),
  UNIQUE (principal_id)
);

CREATE TABLE installation_owner_attempts (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('link', 'recover')),
  expected_owner_id TEXT NOT NULL REFERENCES principals(id),
  link_secret_hash TEXT,
  browser_secret_hash TEXT,
  code_verifier TEXT,
  nonce TEXT,
  principal_id TEXT REFERENCES principals(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'authenticating', 'verified', 'complete')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX installation_owner_attempts_installation ON installation_owner_attempts(installation_id, expires_at);
