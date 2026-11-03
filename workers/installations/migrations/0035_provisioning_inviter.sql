-- The inviting Ship's installation, resolved by Accounts from the contact
-- invitation the signup carried, never an id taken from a request. Set once
-- with the reservation and cleared when the inviter is erased.
ALTER TABLE provisioning_operations ADD COLUMN inviter_installation_id TEXT REFERENCES installations(id) ON DELETE SET NULL;

CREATE INDEX provisioning_inviter_idx
ON provisioning_operations (inviter_installation_id)
WHERE inviter_installation_id IS NOT NULL;

-- Erasing an inviter clears this column on its invitees' operations. An
-- invitee that is itself retiring must not block that erasure, so the
-- retirement guard admits exactly that clearing: the inviter going from set
-- to NULL with every other column unchanged. Any other update stays fenced.
DROP TRIGGER provisioning_operations_retirement_update;
CREATE TRIGGER provisioning_operations_retirement_update BEFORE UPDATE ON provisioning_operations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
  AND NOT (
    OLD.inviter_installation_id IS NOT NULL AND NEW.inviter_installation_id IS NULL
    AND NEW.operation_id IS OLD.operation_id AND NEW.installation_id IS OLD.installation_id
    AND NEW.principal_id IS OLD.principal_id AND NEW.kind IS OLD.kind AND NEW.state IS OLD.state
    AND NEW.attempt IS OLD.attempt AND NEW.last_error IS OLD.last_error
    AND NEW.updated_at IS OLD.updated_at AND NEW.attribution_json IS OLD.attribution_json
  )
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;
