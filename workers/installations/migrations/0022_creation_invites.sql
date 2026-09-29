CREATE TABLE installation_creation_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  policy_ref TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  principal_id TEXT REFERENCES principals(id),
  claimed_at INTEGER,
  installation_id TEXT UNIQUE,
  last_error TEXT CHECK (last_error IS NULL OR last_error IN ('policy_unavailable', 'setup_unavailable')),
  updated_at INTEGER NOT NULL,
  CHECK ((principal_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX installation_creation_invites_owner ON installation_creation_invites(principal_id, created_at);

-- Accounts workers from the preceding version may finish deletion during rollout.
CREATE TRIGGER installation_creation_invites_erased AFTER DELETE ON installations
BEGIN DELETE FROM installation_creation_invites WHERE installation_id = OLD.id; END;
