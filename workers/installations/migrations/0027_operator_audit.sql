-- Operator actions on Ships. Rows outlive the Ship they name: they hold no
-- handle or owner data, only the operator, the action and the operator's reason.
CREATE TABLE operator_audit_events (
  id              TEXT PRIMARY KEY,
  at              INTEGER NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  installation_id TEXT,
  detail_json     TEXT,
  reason          TEXT
);

CREATE INDEX operator_audit_events_at ON operator_audit_events (at DESC);
CREATE INDEX operator_audit_events_installation ON operator_audit_events (installation_id, at DESC);
