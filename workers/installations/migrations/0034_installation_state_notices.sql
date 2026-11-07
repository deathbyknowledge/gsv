-- The state each installation's followers are to be told of, written in the
-- same batch as the change of state. Each follower is told on its own: the
-- Gateway, which has the installation's Kernel keep the state, and the
-- deployment's PDS, which has the installation's account follow it. A
-- follower's notice is pending while the revision it has read is below the
-- notice's.
CREATE TABLE installation_state_notices (
  installation_id      TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  state                TEXT NOT NULL,
  revision             INTEGER NOT NULL CHECK (revision > 0),
  gateway_revision     INTEGER NOT NULL DEFAULT 0 CHECK (gateway_revision >= 0),
  gateway_attempted_at INTEGER NOT NULL DEFAULT 0,
  pds_revision         INTEGER NOT NULL DEFAULT 0 CHECK (pds_revision >= 0),
  pds_attempted_at     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX installation_state_notices_gateway_pending
ON installation_state_notices (gateway_attempted_at) WHERE gateway_revision < revision;
CREATE INDEX installation_state_notices_pds_pending
ON installation_state_notices (pds_attempted_at) WHERE pds_revision < revision;
