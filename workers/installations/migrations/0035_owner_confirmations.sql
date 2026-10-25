-- The codes Accounts emails an installation's owner to confirm one exact change
-- its Kernel asks about. A row keeps only a keyed hash of its code, which names
-- the change, and a code is used once. Sends are paced per installation and
-- purpose, and the newest open code is the only one that counts.
CREATE TABLE owner_confirmations (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  purpose         TEXT NOT NULL CHECK (purpose IN ('recovery-sheet')),
  code_verifier   TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  confirmed_at    INTEGER
);

CREATE INDEX owner_confirmations_sends ON owner_confirmations (installation_id, purpose, created_at);
