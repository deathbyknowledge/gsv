CREATE TABLE installation_deletion_inventories (
  sha256 TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE INDEX installation_deletion_inventory_scope ON installation_deletion_inventories(installation_id, verified_at);

CREATE TABLE installation_deletion_evidence (
  manifest_sha256 TEXT NOT NULL REFERENCES installation_deletion_inventories(sha256) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (manifest_sha256, reference)
);
CREATE TABLE installation_deletion_imports (
  manifest_sha256 TEXT PRIMARY KEY REFERENCES installation_deletion_inventories(sha256) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL
);

CREATE TABLE installation_deleted_operations (
  operation_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL
);
CREATE TRIGGER provisioning_retired_operation_guard BEFORE INSERT ON provisioning_operations
WHEN EXISTS (SELECT 1 FROM installation_deleted_operations WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'installation operation is retired'); END;

CREATE TABLE installation_account_deletions (
  installation_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK (phase IN ('quiesced', 'erasing', 'live-erased', 'erased')),
  updated_at INTEGER NOT NULL,
  backup_expires_at INTEGER
);

CREATE TRIGGER installation_retired_insert_guard BEFORE INSERT ON installations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;
CREATE TRIGGER installation_retired_update_guard BEFORE UPDATE ON installations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.id)
  AND NEW.state NOT IN ('retained', 'deleting', 'deleted')
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER hostnames_retirement_insert BEFORE INSERT ON hostnames
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER hostnames_retirement_update BEFORE UPDATE ON hostnames
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER memberships_retirement_insert BEFORE INSERT ON memberships
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER memberships_retirement_update BEFORE UPDATE ON memberships
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER provisioning_operations_retirement_insert BEFORE INSERT ON provisioning_operations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER provisioning_operations_retirement_update BEFORE UPDATE ON provisioning_operations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER installation_onboarding_claims_retirement_insert BEFORE INSERT ON installation_onboarding_claims
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER installation_onboarding_claims_retirement_update BEFORE UPDATE ON installation_onboarding_claims
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER installation_owner_attempts_retirement_insert BEFORE INSERT ON installation_owner_attempts
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER installation_owner_attempts_retirement_update BEFORE UPDATE ON installation_owner_attempts
WHEN EXISTS (SELECT 1 FROM installation_account_deletions WHERE installation_id = NEW.installation_id)
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;

CREATE TRIGGER installation_reset_retirement_guard BEFORE INSERT ON installation_reset_operations
WHEN EXISTS (SELECT 1 FROM installation_account_deletions
  WHERE installation_id IN (NEW.previous_installation_id, NEW.replacement_installation_id))
BEGIN SELECT RAISE(ABORT, 'installation is retired'); END;
