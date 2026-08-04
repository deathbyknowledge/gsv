CREATE TABLE installation_deletion_operations (
  operation_id                   TEXT PRIMARY KEY,
  installation_id               TEXT NOT NULL REFERENCES installations(id),
  requested_by_principal_id      TEXT REFERENCES principals(id) ON DELETE SET NULL,
  request_kind                   TEXT NOT NULL CHECK (request_kind IN ('user', 'retention')),
  previous_state                 TEXT NOT NULL CHECK (previous_state IN (
    'trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained'
  )),
  state                          TEXT NOT NULL CHECK (state IN (
    'preparing', 'recoverable', 'deleting', 'complete', 'recovered'
  )),
  recoverable_until              INTEGER NOT NULL,
  gateway_prepared               INTEGER NOT NULL DEFAULT 0 CHECK (gateway_prepared IN (0, 1)),
  inference_suspended            INTEGER NOT NULL DEFAULT 0 CHECK (inference_suspended IN (0, 1)),
  telegram_suspended             INTEGER NOT NULL DEFAULT 0 CHECK (telegram_suspended IN (0, 1)),
  gateway_deleted                INTEGER NOT NULL DEFAULT 0 CHECK (gateway_deleted IN (0, 1)),
  inference_deleted              INTEGER NOT NULL DEFAULT 0 CHECK (inference_deleted IN (0, 1)),
  telegram_deleted               INTEGER NOT NULL DEFAULT 0 CHECK (telegram_deleted IN (0, 1)),
  attempt                        INTEGER NOT NULL DEFAULT 0,
  last_error_code                TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  completed_at                   INTEGER,
  CHECK (recoverable_until >= created_at),
  CHECK (request_kind != 'user' OR requested_by_principal_id IS NOT NULL),
  CHECK ((state IN ('complete', 'recovered')) = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX installation_deletion_active_idx
ON installation_deletion_operations (installation_id)
WHERE state IN ('preparing', 'recoverable', 'deleting');

CREATE INDEX installation_deletion_due_idx
ON installation_deletion_operations (state, recoverable_until, updated_at);
