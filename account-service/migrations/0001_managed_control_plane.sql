PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  id                       TEXT PRIMARY KEY,
  primary_email            TEXT NOT NULL,
  primary_email_normalized TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  email_verified_at        INTEGER,
  state                    TEXT NOT NULL CHECK (state IN ('pending', 'active', 'recovery', 'disabled')),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE credentials (
  id                TEXT PRIMARY KEY,
  principal_id      TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('passkey', 'recovery_code')),
  lookup_key        TEXT NOT NULL,
  public_data_json  TEXT,
  secret_hash       TEXT,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  revoked_at        INTEGER,
  UNIQUE (kind, lookup_key),
  CHECK (
    (kind = 'passkey' AND public_data_json IS NOT NULL AND secret_hash IS NULL)
    OR (kind = 'recovery_code' AND public_data_json IS NULL AND secret_hash IS NOT NULL)
  )
);

CREATE INDEX credentials_principal_idx
ON credentials (principal_id, kind, revoked_at);

CREATE TABLE sessions (
  id_hash         TEXT PRIMARY KEY,
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  recent_auth_at  INTEGER NOT NULL,
  revoked_at      INTEGER,
  ip_hash         TEXT,
  user_agent      TEXT
);

CREATE INDEX sessions_principal_idx
ON sessions (principal_id, revoked_at, expires_at);

CREATE TABLE installations (
  id                  TEXT PRIMARY KEY,
  owner_principal_id  TEXT NOT NULL REFERENCES principals(id),
  handle              TEXT NOT NULL UNIQUE,
  canonical_origin    TEXT NOT NULL UNIQUE,
  state               TEXT NOT NULL CHECK (state IN (
    'reserved', 'provisioning', 'trialing', 'active', 'past_due',
    'restricted', 'cancelled', 'retained', 'deleting', 'deleted'
  )),
  provision_version   INTEGER NOT NULL,
  reservation_expires_at INTEGER,
  created_at          INTEGER NOT NULL,
  activated_at        INTEGER,
  retained_until      INTEGER,
  deleted_at          INTEGER
);

CREATE TABLE hostnames (
  normalized_hostname TEXT PRIMARY KEY,
  installation_id     TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('canonical', 'alias')),
  state               TEXT NOT NULL CHECK (state IN ('reserved', 'provisioning', 'active', 'retired')),
  created_at          INTEGER NOT NULL,
  retired_at          INTEGER
);

CREATE INDEX hostnames_installation_idx
ON hostnames (installation_id, state);

CREATE TABLE memberships (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  local_uid       INTEGER,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, principal_id),
  UNIQUE (installation_id, local_uid)
);

CREATE TABLE provisioning_operations (
  operation_id    TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL REFERENCES principals(id),
  kind            TEXT NOT NULL CHECK (kind IN ('create', 'repair')),
  state           TEXT NOT NULL CHECK (state IN ('reserved', 'provisioning', 'complete', 'failed')),
  attempt         INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX provisioning_installation_idx
ON provisioning_operations (installation_id, updated_at);

CREATE TABLE billing_accounts (
  id                    TEXT PRIMARY KEY,
  principal_id          TEXT NOT NULL REFERENCES principals(id),
  provider              TEXT NOT NULL,
  provider_customer_id  TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (provider, provider_customer_id)
);

CREATE TABLE subscriptions (
  id                       TEXT PRIMARY KEY,
  billing_account_id       TEXT NOT NULL REFERENCES billing_accounts(id),
  installation_id          TEXT NOT NULL REFERENCES installations(id),
  provider_subscription_id TEXT NOT NULL,
  price_key                TEXT NOT NULL,
  state                    TEXT NOT NULL,
  paid_through             INTEGER,
  updated_at               INTEGER NOT NULL,
  UNIQUE (installation_id),
  UNIQUE (provider_subscription_id)
);

CREATE TABLE billing_events (
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER,
  outcome           TEXT,
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE entitlements (
  installation_id              TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  state                        TEXT NOT NULL,
  plan_key                     TEXT NOT NULL,
  inference_budget_microunits  INTEGER NOT NULL,
  storage_limit_bytes          INTEGER NOT NULL,
  effective_at                 INTEGER NOT NULL,
  version                      INTEGER NOT NULL
);

CREATE TABLE login_handoffs (
  token_prefix     TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL,
  principal_id     TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  local_uid        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER
);

CREATE INDEX login_handoffs_expiry_idx
ON login_handoffs (expires_at, used_at);

CREATE TABLE verification_and_recovery_tokens (
  token_prefix TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL CHECK (purpose IN ('verify_email', 'recover_account', 'passkey_challenge')),
  payload_json TEXT,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);

CREATE INDEX verification_tokens_expiry_idx
ON verification_and_recovery_tokens (expires_at, used_at);

CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,
  principal_id    TEXT REFERENCES principals(id) ON DELETE SET NULL,
  installation_id TEXT REFERENCES installations(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_events_principal_idx
ON audit_events (principal_id, created_at DESC);

CREATE INDEX audit_events_installation_idx
ON audit_events (installation_id, created_at DESC);

CREATE TABLE rate_limit_buckets (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
