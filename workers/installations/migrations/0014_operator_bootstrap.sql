CREATE TABLE operator_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  claim_id TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('access', 'operator')),
  operation_id TEXT NOT NULL UNIQUE,
  handle TEXT,
  onboarding_token_prefix TEXT,
  onboarding_token_hash TEXT,
  operator_token_prefix TEXT,
  operator_token_hash TEXT,
  installation_id TEXT REFERENCES installations(id),
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE operator_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
