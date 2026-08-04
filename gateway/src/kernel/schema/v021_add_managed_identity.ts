import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V021_ADD_MANAGED_IDENTITY: SqlMigration = {
  id: 21,
  name: "add_managed_identity",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS managed_provisioning_operations (
        operation_id      TEXT PRIMARY KEY,
        owner_principal_id TEXT NOT NULL,
        owner_username    TEXT NOT NULL,
        local_uid         INTEGER,
        provision_version INTEGER NOT NULL,
        state             TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'failed')),
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        last_error        TEXT
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_principal_memberships (
        principal_id TEXT PRIMARY KEY,
        local_uid    INTEGER NOT NULL UNIQUE,
        role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        state        TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        created_at   INTEGER NOT NULL,
        revoked_at   INTEGER
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_login_sessions (
        token_id     TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        local_uid    INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        revoked_at   INTEGER,
        FOREIGN KEY (principal_id) REFERENCES managed_principal_memberships(principal_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS managed_login_sessions_principal_idx
      ON managed_login_sessions (principal_id, revoked_at, expires_at)
    `,
  ],
};
