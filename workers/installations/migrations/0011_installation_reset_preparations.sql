CREATE TABLE installation_reset_participants (
  operation_id TEXT NOT NULL REFERENCES installation_reset_operations(operation_id),
  participant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'prepared')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, participant_id)
);

CREATE INDEX installation_reset_pending_participants
ON installation_reset_participants (state, operation_id);

CREATE TRIGGER installation_reset_preparation_guard
BEFORE UPDATE OF state ON installations
WHEN NEW.state IN ('provisioning', 'active') AND EXISTS (
  SELECT 1 FROM installation_reset_operations r
  JOIN installation_reset_participants p ON p.operation_id = r.operation_id
  WHERE r.replacement_installation_id = NEW.id AND p.state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'installation reset preparation is pending');
END;
