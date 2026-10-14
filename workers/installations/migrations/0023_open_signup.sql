ALTER TABLE installations ADD COLUMN owner_setup INTEGER NOT NULL DEFAULT 0 CHECK (owner_setup IN (0, 1));

-- Preserve recovery of spaces created through the former signup-code flow.
UPDATE installations SET owner_setup = 1 WHERE EXISTS (
  SELECT 1 FROM installation_creation_invites c
  WHERE c.installation_id = installations.id AND c.principal_id = installations.owner_principal_id
    AND c.revoked_at IS NULL
);
