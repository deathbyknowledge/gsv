CREATE TABLE installation_reset_operations (
  operation_id               TEXT PRIMARY KEY,
  previous_installation_id   TEXT NOT NULL UNIQUE,
  replacement_installation_id TEXT NOT NULL UNIQUE,
  handle                     TEXT NOT NULL,
  canonical_origin           TEXT NOT NULL,
  canonical_hostname         TEXT NOT NULL,
  data_deletion_state        TEXT NOT NULL CHECK (data_deletion_state IN (
    'pending', 'deleting', 'complete', 'failed'
  )),
  last_error                 TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  completed_at               INTEGER
);

CREATE INDEX installation_reset_deletion_idx
ON installation_reset_operations (data_deletion_state, updated_at);
