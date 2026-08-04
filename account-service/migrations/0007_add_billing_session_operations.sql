CREATE TABLE billing_session_operations (
  operation_id       TEXT PRIMARY KEY,
  principal_id       TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  installation_id    TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('checkout', 'portal')),
  plan_key            TEXT,
  provider_session_id TEXT,
  provider_session_expires_at INTEGER,
  state               TEXT NOT NULL CHECK (state IN (
    'created', 'complete', 'failed', 'expired'
  )),
  attempt             INTEGER NOT NULL DEFAULT 0,
  last_error_code     TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK ((kind = 'checkout') = (plan_key IS NOT NULL)),
  CHECK ((state IN ('complete', 'expired')) = (provider_session_id IS NOT NULL)),
  CHECK (provider_session_expires_at IS NULL OR provider_session_id IS NOT NULL),
  CHECK (
    kind != 'checkout'
    OR state NOT IN ('complete', 'expired')
    OR provider_session_expires_at IS NOT NULL
  )
);

CREATE INDEX billing_session_operations_principal_idx
ON billing_session_operations (principal_id, updated_at DESC);

CREATE INDEX billing_session_operations_installation_idx
ON billing_session_operations (installation_id, kind, updated_at DESC);

CREATE UNIQUE INDEX billing_session_operations_active_checkout_idx
ON billing_session_operations (installation_id)
WHERE kind = 'checkout' AND state IN ('created', 'complete');
