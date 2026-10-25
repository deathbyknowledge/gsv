-- The state each installation's Kernel is to be told of, written in the same
-- batch as the change of state. A notice is pending while its Kernel has not
-- read that revision.
CREATE TABLE installation_state_notices (
  installation_id    TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  state              TEXT NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision > 0),
  delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK (delivered_revision >= 0),
  attempted_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX installation_state_notices_pending
ON installation_state_notices (attempted_at) WHERE delivered_revision < revision;
