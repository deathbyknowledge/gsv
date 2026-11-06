-- One row per address: an explicit signup choice, or an operator-confirmed import of
-- earlier choices, queued for the optional ProductEmailService. Nobody is added here.
CREATE TABLE product_email_signups (
  email TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ship-signup', 'ship-existing-user-backfill')),
  consent_basis TEXT NOT NULL CHECK (consent_basis IN ('signup-checkbox', 'operator-confirmed-existing-opt-ins')),
  consented_at INTEGER,
  import_id TEXT,
  wording_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  ip TEXT,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  last_error TEXT
);
CREATE INDEX product_email_signups_due ON product_email_signups(due_at) WHERE completed_at IS NULL;
