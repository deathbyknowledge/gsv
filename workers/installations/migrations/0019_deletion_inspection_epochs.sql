CREATE TABLE installation_deletion_inspections (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  sealed_manifest_sha256 TEXT,
  sealed_at INTEGER,
  CHECK ((sealed_manifest_sha256 IS NULL) = (sealed_at IS NULL))
);
CREATE INDEX installation_deletion_inspections_installation_idx
ON installation_deletion_inspections (installation_id, created_at);

CREATE TABLE installation_deletion_observations (
  inspection_id TEXT NOT NULL REFERENCES installation_deletion_inspections(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_json TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (inspection_id, namespace_id, object_id)
);
CREATE INDEX installation_deletion_observations_installation_idx
ON installation_deletion_observations (installation_id);

CREATE TABLE installation_deletion_owner_imports (
  manifest_sha256 TEXT NOT NULL REFERENCES installation_deletion_inventories(sha256) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (manifest_sha256, owner_id)
);
