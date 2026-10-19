-- Temporary bridge: remove in a later migration after pre-open-signup Accounts workers have drained.
CREATE TRIGGER installation_creation_invites_owner_setup
AFTER UPDATE OF installation_id ON installation_creation_invites
WHEN NEW.installation_id IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN
  UPDATE installations SET owner_setup = 1
  WHERE id = NEW.installation_id AND owner_principal_id = NEW.principal_id;
END;

-- Include writes admitted after migration 0023 and before this bridge was installed.
UPDATE installations SET owner_setup = 1 WHERE EXISTS (
  SELECT 1 FROM installation_creation_invites c
  WHERE c.installation_id = installations.id AND c.principal_id = installations.owner_principal_id
    AND c.revoked_at IS NULL
);
