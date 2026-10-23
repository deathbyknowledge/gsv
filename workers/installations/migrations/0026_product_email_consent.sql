-- Accounts is the sole consent authority. No existing owner or website row is opted in.
CREATE TABLE product_email_consent (
  email TEXT PRIMARY KEY,
  principal_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  opted_in INTEGER NOT NULL DEFAULT 0 CHECK (opted_in IN (0,1)),
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0,1)),
  source TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  evidence TEXT,
  updated_at INTEGER NOT NULL,
  provider_ip TEXT,
  provider_id TEXT,
  provider_status TEXT NOT NULL DEFAULT 'unknown',
  request_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX product_email_due ON product_email_consent(due_at, lease_until);
CREATE UNIQUE INDEX product_email_provider ON product_email_consent(provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE product_email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  principal_id TEXT,
  revision INTEGER NOT NULL,
  opted_in INTEGER NOT NULL,
  suppressed INTEGER NOT NULL,
  source TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  evidence TEXT,
  recorded_at INTEGER NOT NULL,
  UNIQUE(email, revision)
);
CREATE TRIGGER product_email_created AFTER INSERT ON product_email_consent BEGIN
  INSERT INTO product_email_events(email,principal_id,revision,opted_in,suppressed,source,wording_version,locale,evidence,recorded_at)
    VALUES(NEW.email,NEW.principal_id,NEW.revision,NEW.opted_in,NEW.suppressed,NEW.source,NEW.wording_version,NEW.locale,NEW.evidence,NEW.updated_at);
END;
CREATE TRIGGER product_email_changed AFTER UPDATE OF revision ON product_email_consent WHEN NEW.revision != OLD.revision BEGIN
  INSERT INTO product_email_events(email,principal_id,revision,opted_in,suppressed,source,wording_version,locale,evidence,recorded_at)
    VALUES(NEW.email,NEW.principal_id,NEW.revision,NEW.opted_in,NEW.suppressed,NEW.source,NEW.wording_version,NEW.locale,NEW.evidence,NEW.updated_at);
END;
CREATE TABLE product_email_intents (
  challenge_id TEXT PRIMARY KEY REFERENCES owner_auth_challenges(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  baseline_revision INTEGER NOT NULL,
  provider_ip TEXT,
  locale TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE product_email_webhooks (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  subscriber_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at INTEGER,
  due_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE product_email_rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
-- Withdrawing on identity changes happens in the identity transaction, before another job can start.
CREATE TRIGGER product_email_principal_changed AFTER UPDATE OF state, primary_email_normalized ON principals
WHEN NEW.state != 'active' OR NEW.primary_email_normalized != OLD.primary_email_normalized BEGIN
  UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source='account-changed',
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,due_at=0,attempts=0,
    request_id=lower(hex(randomblob(16))) WHERE (principal_id=OLD.id OR email=OLD.primary_email_normalized) AND suppressed=0;
END;
CREATE TRIGGER product_email_principal_deleted BEFORE DELETE ON principals BEGIN
  UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source='account-deleted',
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,due_at=0,attempts=0,
    request_id=lower(hex(randomblob(16))) WHERE principal_id=OLD.id OR email=OLD.primary_email_normalized;
END;
CREATE TRIGGER product_email_credential_revoked AFTER UPDATE OF revoked_at,email_normalized ON principal_email_credentials
WHEN NEW.revoked_at IS NOT NULL OR NEW.email_normalized != OLD.email_normalized BEGIN
  UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source='email-changed',
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,due_at=0,attempts=0,
    request_id=lower(hex(randomblob(16))) WHERE (principal_id=OLD.principal_id OR email=OLD.email_normalized) AND suppressed=0;
END;
CREATE TRIGGER product_email_credential_deleted BEFORE DELETE ON principal_email_credentials BEGIN
  UPDATE product_email_consent SET opted_in=0,suppressed=1,revision=revision+1,source='email-removed',
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000,due_at=0,attempts=0,
    request_id=lower(hex(randomblob(16))) WHERE (principal_id=OLD.principal_id OR email=OLD.email_normalized) AND suppressed=0;
END;
CREATE TABLE service_notices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL
);
CREATE TABLE service_notice_deliveries (
  notice_id TEXT NOT NULL REFERENCES service_notices(id),
  principal_id TEXT NOT NULL,
  email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','unknown','cancelled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(notice_id,principal_id)
);

CREATE TABLE service_notice_targets (
  notice_id TEXT NOT NULL REFERENCES service_notices(id),
  installation_id TEXT NOT NULL,
  PRIMARY KEY(notice_id,installation_id)
);
