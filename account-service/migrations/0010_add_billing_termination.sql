CREATE TABLE billing_termination_operations (
  operation_id             TEXT PRIMARY KEY,
  deletion_operation_id    TEXT NOT NULL UNIQUE
    REFERENCES installation_deletion_operations(operation_id),
  installation_id          TEXT NOT NULL REFERENCES installations(id),
  provider                 TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'requested' CHECK (state IN (
    'requested', 'processing', 'complete', 'cancelled', 'failed'
  )),
  attempt                  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at          INTEGER NOT NULL,
  lease_nonce              TEXT,
  lease_until              INTEGER,
  provider_observed_at     INTEGER,
  last_error_code          TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  completed_at             INTEGER,
  CHECK (
    (state = 'processing' AND lease_nonce IS NOT NULL AND lease_until IS NOT NULL)
    OR (state != 'processing' AND lease_nonce IS NULL AND lease_until IS NULL)
  ),
  CHECK ((state = 'complete') = (provider_observed_at IS NOT NULL)),
  CHECK ((state IN ('complete', 'cancelled', 'failed')) = (completed_at IS NOT NULL))
);

CREATE INDEX billing_termination_due_idx
ON billing_termination_operations (state, next_attempt_at, lease_until);
