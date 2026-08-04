ALTER TABLE billing_accounts
ADD COLUMN updated_at INTEGER;

UPDATE billing_accounts
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE UNIQUE INDEX billing_accounts_principal_provider_idx
ON billing_accounts (principal_id, provider);

ALTER TABLE subscriptions RENAME TO subscriptions_legacy;

CREATE TABLE subscriptions (
  id                       TEXT PRIMARY KEY,
  billing_account_id       TEXT NOT NULL REFERENCES billing_accounts(id),
  installation_id          TEXT NOT NULL REFERENCES installations(id),
  provider_subscription_id TEXT NOT NULL,
  price_key                TEXT NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN (
    'pending', 'trialing', 'active', 'past_due', 'restricted',
    'cancelled', 'retained'
  )),
  provider_state           TEXT NOT NULL CHECK (provider_state IN (
    'pending', 'trialing', 'active', 'past_due', 'cancelled'
  )),
  provider_observed_at     INTEGER NOT NULL,
  provider_snapshot_hash   TEXT NOT NULL,
  current_period_starts_at INTEGER NOT NULL,
  current_period_ends_at   INTEGER NOT NULL,
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_at_period_end IN (0, 1)),
  paid_through             INTEGER,
  grace_ends_at            INTEGER,
  retention_ends_at        INTEGER,
  entitlement_version      INTEGER NOT NULL DEFAULT 0,
  entitlement_effective_at INTEGER,
  entitlement_json         TEXT,
  last_reconciled_at       INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE (installation_id),
  UNIQUE (billing_account_id, provider_subscription_id),
  CHECK (current_period_ends_at > current_period_starts_at),
  CHECK ((entitlement_json IS NULL) = (entitlement_effective_at IS NULL)),
  CHECK (
    (entitlement_json IS NULL AND entitlement_version = 0)
    OR (entitlement_json IS NOT NULL AND entitlement_version > 0)
  )
);

INSERT INTO subscriptions (
  id, billing_account_id, installation_id, provider_subscription_id,
  price_key, state, provider_state, provider_observed_at,
  provider_snapshot_hash, current_period_starts_at,
  current_period_ends_at, cancel_at_period_end, paid_through,
  grace_ends_at, retention_ends_at, entitlement_version,
  entitlement_effective_at, entitlement_json, last_reconciled_at, updated_at
)
SELECT
  id, billing_account_id, installation_id, provider_subscription_id,
  price_key,
  CASE
    WHEN state IN ('trialing', 'active', 'past_due', 'restricted', 'cancelled', 'retained')
      THEN state
    ELSE 'pending'
  END,
  CASE
    WHEN state IN ('trialing', 'active', 'past_due', 'cancelled') THEN state
    WHEN state IN ('restricted', 'retained') THEN 'cancelled'
    ELSE 'pending'
  END,
  updated_at,
  'legacy',
  COALESCE(paid_through - 2592000000, updated_at),
  COALESCE(paid_through, updated_at + 2592000000),
  0,
  paid_through,
  NULL,
  NULL,
  0,
  NULL,
  NULL,
  updated_at,
  updated_at
FROM subscriptions_legacy;

DROP TABLE subscriptions_legacy;

ALTER TABLE billing_events RENAME TO billing_events_legacy;

CREATE TABLE billing_events (
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  body_hash         TEXT NOT NULL,
  event_created_at  INTEGER NOT NULL,
  subject_kind      TEXT NOT NULL CHECK (subject_kind IN ('subscription', 'other')),
  subject_id        TEXT,
  state             TEXT NOT NULL CHECK (state IN ('received', 'processing', 'processed', 'failed')),
  attempt           INTEGER NOT NULL DEFAULT 0,
  lease_nonce       TEXT,
  lease_until       INTEGER,
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER,
  outcome           TEXT,
  last_error_code   TEXT,
  PRIMARY KEY (provider, provider_event_id),
  CHECK (
    (state = 'processing' AND lease_nonce IS NOT NULL AND lease_until IS NOT NULL)
    OR (state != 'processing' AND lease_nonce IS NULL AND lease_until IS NULL)
  ),
  CHECK ((subject_kind = 'subscription') = (subject_id IS NOT NULL))
);

INSERT INTO billing_events (
  provider, provider_event_id, body_hash, event_created_at,
  subject_kind, subject_id, state, attempt, lease_nonce, lease_until,
  received_at, processed_at, outcome, last_error_code
)
SELECT
  provider, provider_event_id, 'legacy', received_at,
  'other', NULL,
  CASE WHEN processed_at IS NULL THEN 'received' ELSE 'processed' END,
  CASE WHEN processed_at IS NULL THEN 0 ELSE 1 END,
  NULL, NULL, received_at, processed_at, outcome, NULL
FROM billing_events_legacy;

DROP TABLE billing_events_legacy;

CREATE INDEX billing_events_state_idx
ON billing_events (state, lease_until, received_at);

CREATE INDEX subscriptions_lifecycle_idx
ON subscriptions (state, grace_ends_at, paid_through, retention_ends_at);
