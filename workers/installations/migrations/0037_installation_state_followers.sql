-- Each follower of an installation's state is told of its notice on its own:
-- the Gateway, which has the installation's Kernel keep the state, and the
-- deployment's PDS, which has the installation's account follow it. A
-- follower's notice is pending while the revision it has read is below the
-- notice's.
DROP INDEX installation_state_notices_pending;
ALTER TABLE installation_state_notices RENAME COLUMN delivered_revision TO gateway_revision;
ALTER TABLE installation_state_notices RENAME COLUMN attempted_at TO gateway_attempted_at;
ALTER TABLE installation_state_notices ADD COLUMN pds_revision INTEGER NOT NULL DEFAULT 0 CHECK (pds_revision >= 0);
ALTER TABLE installation_state_notices ADD COLUMN pds_attempted_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX installation_state_notices_gateway_pending
ON installation_state_notices (gateway_attempted_at) WHERE gateway_revision < revision;
CREATE INDEX installation_state_notices_pds_pending
ON installation_state_notices (pds_attempted_at) WHERE pds_revision < revision;
