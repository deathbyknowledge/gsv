CREATE TABLE lifecycle_notification_outbox (
  id                  TEXT PRIMARY KEY,
  installation_id     TEXT NOT NULL REFERENCES installations(id),
  principal_id        TEXT NOT NULL REFERENCES principals(id),
  kind                TEXT NOT NULL CHECK (kind IN (
    'payment_past_due',
    'service_restricted',
    'retention_started',
    'retention_7_days',
    'retention_1_day',
    'user_deletion_requested',
    'user_deletion_recovered',
    'installation_deleted'
  )),
  source_id           TEXT NOT NULL,
  lifecycle_key       TEXT NOT NULL,
  deadline_at         INTEGER,
  scheduled_at        INTEGER NOT NULL,
  expires_at          INTEGER,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'sending', 'sent', 'permanent_failure', 'expired'
  )),
  attempt             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER NOT NULL,
  lease_nonce         TEXT,
  lease_until         INTEGER,
  provider_message_id TEXT,
  last_error_code     TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  sent_at             INTEGER,
  UNIQUE (kind, source_id, lifecycle_key),
  CHECK (expires_at IS NULL OR expires_at > scheduled_at),
  CHECK (
    (state = 'sending' AND lease_nonce IS NOT NULL AND lease_until IS NOT NULL)
    OR (state != 'sending' AND lease_nonce IS NULL AND lease_until IS NULL)
  ),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((state = 'sent') = (provider_message_id IS NOT NULL))
);

CREATE INDEX lifecycle_notification_delivery_idx
ON lifecycle_notification_outbox (state, next_attempt_at, lease_until, scheduled_at);

CREATE INDEX lifecycle_notification_installation_idx
ON lifecycle_notification_outbox (installation_id, kind, state);
