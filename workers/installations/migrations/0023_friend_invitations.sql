-- Keep consumed places independently of the recipient's later deletion.
CREATE TABLE friend_invitations (
  id TEXT PRIMARY KEY,
  sponsor_installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  contact_invite_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  consumed_at INTEGER,
  recipient_origin TEXT,
  UNIQUE(sponsor_installation_id, contact_invite_id)
);
CREATE INDEX friend_invitations_sponsor ON friend_invitations(sponsor_installation_id, consumed_at, expires_at);

CREATE TRIGGER friend_invitation_consumed AFTER UPDATE OF installation_id ON installation_creation_invites
WHEN NEW.installation_id IS NOT NULL
BEGIN
  UPDATE friend_invitations SET consumed_at = COALESCE(consumed_at, NEW.updated_at)
  WHERE id = NEW.id;
END;

CREATE TRIGGER friend_invitation_revoked AFTER UPDATE OF revoked_at ON installation_creation_invites
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE friend_invitations SET released_at = COALESCE(released_at, NEW.revoked_at)
  WHERE id = NEW.id AND consumed_at IS NULL;
END;

CREATE TRIGGER friend_invitation_sponsor_deleted BEFORE DELETE ON installations
BEGIN
  DELETE FROM installation_creation_invites WHERE id IN (
    SELECT id FROM friend_invitations WHERE sponsor_installation_id = OLD.id AND consumed_at IS NULL
  );
END;
