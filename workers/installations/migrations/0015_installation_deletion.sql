CREATE TABLE installation_deletions (
  operation_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE,
  inventory_sha256 TEXT NOT NULL,
  owners_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('quiescing', 'erasing', 'live-erased', 'erased')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX installation_deletions_pending_idx
ON installation_deletions (phase, updated_at);

CREATE TABLE installation_deletion_owners (
  operation_id TEXT NOT NULL REFERENCES installation_deletions(operation_id),
  owner_id TEXT NOT NULL,
  receipt_json TEXT,
  outcome TEXT NOT NULL DEFAULT 'progress',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, owner_id)
);
