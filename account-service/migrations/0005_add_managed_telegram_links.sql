CREATE TABLE managed_telegram_link_operations (
  operation_id              TEXT PRIMARY KEY,
  claim_id                  TEXT NOT NULL UNIQUE,
  claim_token_hash          TEXT NOT NULL UNIQUE,
  principal_id              TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  actor_id                  TEXT NOT NULL,
  surface_id                TEXT NOT NULL,
  target_installation_id    TEXT NOT NULL REFERENCES installations(id),
  target_local_uid          INTEGER NOT NULL,
  target_canonical_origin   TEXT NOT NULL,
  previous_installation_id  TEXT,
  previous_local_uid        INTEGER,
  previous_canonical_origin TEXT,
  state                     TEXT NOT NULL CHECK (state IN (
    'created', 'route_suspended', 'old_kernel_unlinked',
    'new_kernel_linked', 'complete'
  )),
  attempt                   INTEGER NOT NULL DEFAULT 0,
  last_error_code           TEXT,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  completed_at              INTEGER,
  CHECK (actor_id = surface_id),
  CHECK (
    (previous_installation_id IS NULL
      AND previous_local_uid IS NULL
      AND previous_canonical_origin IS NULL)
    OR
    (previous_installation_id IS NOT NULL
      AND previous_local_uid IS NOT NULL
      AND previous_canonical_origin IS NOT NULL)
  )
);

CREATE INDEX managed_telegram_links_principal_idx
ON managed_telegram_link_operations (principal_id, updated_at DESC);

CREATE INDEX managed_telegram_links_target_idx
ON managed_telegram_link_operations (target_installation_id, state);
