-- The inviting Ship's installation, resolved by Accounts from the contact
-- invitation the signup carried, never an id taken from a request. Set once
-- with the reservation and cleared when the inviter is erased.
ALTER TABLE provisioning_operations ADD COLUMN inviter_installation_id TEXT REFERENCES installations(id) ON DELETE SET NULL;

CREATE INDEX provisioning_inviter_idx
ON provisioning_operations (inviter_installation_id)
WHERE inviter_installation_id IS NOT NULL;

-- Erasing an inviter clears this column on its invitees' operations. An
-- invitee that is itself retiring must not block that erasure, so the
-- retirement guard admits exactly the clearing of a recorded inviter.
DROP TRIGGER provisioning_operations_retirement_update;
CREATE TRIGGER provisioning_operations_retirement_update BEFORE UPDATE ON provisioning_operations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
  AND NOT (OLD.inviter_installation_id IS NOT NULL AND NEW.inviter_installation_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;
