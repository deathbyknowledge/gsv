CREATE TABLE installation_operator_resources (
  installation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  catalog_json TEXT NOT NULL,
  catalog_sha256 TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('quiesced', 'erasing', 'live-erased', 'finalizing', 'erased')),
  evidence_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE installation_operator_resource_evidence (
  installation_id TEXT NOT NULL REFERENCES installation_operator_resources(installation_id),
  resource_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  capture_json TEXT NOT NULL,
  PRIMARY KEY (installation_id, resource_id, captured_at),
  UNIQUE (installation_id, resource_id, sha256)
);
