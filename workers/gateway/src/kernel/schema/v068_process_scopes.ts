import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V068_PROCESS_SCOPES: SqlMigration = {
  id: 68, name: "process_scopes",
  statements: [
    "ALTER TABLE processes ADD COLUMN scope_id TEXT",
    "CREATE INDEX processes_scope ON processes (scope_id, process_id)",
    `CREATE TABLE process_scopes (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, root_pid TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL, state TEXT NOT NULL, policy_json TEXT NOT NULL,
      processes_used INTEGER NOT NULL DEFAULT 0, generations_used INTEGER NOT NULL DEFAULT 0,
      messages_used INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX process_scopes_owner ON process_scopes (owner_uid, created_at)",
    `CREATE TABLE process_scope_effects (
      scope_id TEXT NOT NULL, kind TEXT NOT NULL, effect_id TEXT NOT NULL,
      PRIMARY KEY (scope_id, kind, effect_id)
    )`,
  ],
};
