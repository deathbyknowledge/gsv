-- The operator's queue of message requests a Ship's person reported. A report
-- names the sender by DID and handle, with its category and when the request
-- arrived; the sender's name and message are here only when the person chose
-- to include them, and only until 90 days after the report closes. Reports go
-- with the reporting Ship when it is deleted.
CREATE TABLE request_reports (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  -- The reporting Ship's own id for the request: a request is reported once.
  request_key     TEXT NOT NULL,
  sender_did      TEXT NOT NULL,
  sender_handle   TEXT,
  sender_name     TEXT,
  message_text    TEXT,
  category        TEXT NOT NULL CHECK (category IN ('spam', 'harassment', 'impersonation', 'sexual', 'other')),
  received_at     INTEGER NOT NULL,
  reported_at     INTEGER NOT NULL,
  closed_at       INTEGER,
  resolution      TEXT CHECK (resolution IN ('dismissed', 'taken-down')),
  -- The audit event of the operator action that closed the report.
  closed_by       TEXT,
  UNIQUE (installation_id, request_key),
  CHECK ((sender_name IS NULL) = (message_text IS NULL)),
  CHECK ((closed_at IS NULL) = (resolution IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);

CREATE INDEX request_reports_open ON request_reports (reported_at DESC) WHERE closed_at IS NULL;
CREATE INDEX request_reports_closed ON request_reports (closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE INDEX request_reports_sender ON request_reports (sender_did) WHERE closed_at IS NULL;
CREATE INDEX request_reports_messages ON request_reports (closed_at) WHERE message_text IS NOT NULL;
CREATE INDEX operator_audit_events_report ON operator_audit_events (json_extract(detail_json, '$.report'));
