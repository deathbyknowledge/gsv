CREATE TABLE product_email_signups (
  email TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
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
