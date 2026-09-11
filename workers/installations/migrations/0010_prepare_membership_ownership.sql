-- Keep old Worker inserts valid while new Workers stop writing Kernel-owned
-- fields. Drop these columns only after this revision is deployed and drained.
CREATE TABLE memberships_next (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  local_uid       INTEGER,
  role            TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, principal_id),
  UNIQUE (installation_id, local_uid)
);

INSERT INTO memberships_next (
  installation_id, principal_id, local_uid, role, state, created_at
)
SELECT installation_id, principal_id, local_uid, role, state, created_at
FROM memberships;

DROP TABLE memberships;
ALTER TABLE memberships_next RENAME TO memberships;
