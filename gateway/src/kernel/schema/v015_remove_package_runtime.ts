import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V015_REMOVE_PACKAGE_RUNTIME: SqlMigration = {
  id: 15,
  name: "remove_package_runtime",
  statements: [
    "DROP TABLE app_session_client_keys",
    "DROP TABLE app_session_clients",
    "DROP TABLE app_sessions",
    "DROP TABLE packages",
    "DELETE FROM routing_table WHERE origin_type = 'app'",
    "DELETE FROM notifications WHERE json_extract(source_json, '$.kind') = 'app'",
    `
      ALTER TABLE signal_watches
      RENAME TO signal_watches_with_package_targets
    `,
    `
      CREATE TABLE signal_watches (
        watch_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'process' CHECK (target_type = 'process'),
        target_process_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        process_id TEXT,
        dedupe_key TEXT,
        state_json TEXT NOT NULL DEFAULT 'null',
        once_only INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `,
    `
      INSERT INTO signal_watches (
        watch_id, uid, target_type, target_process_id, signal, process_id,
        dedupe_key, state_json, once_only, status, error, created_at, updated_at, expires_at
      )
      SELECT
        watch_id, uid, 'process', target_process_id, signal, process_id,
        dedupe_key, state_json, once_only, status, error, created_at, updated_at, expires_at
      FROM signal_watches_with_package_targets
      WHERE target_type = 'process' AND target_process_id IS NOT NULL
    `,
    "DROP TABLE signal_watches_with_package_targets",
    `
      CREATE INDEX idx_signal_watches_active
      ON signal_watches (uid, signal, status, process_id, expires_at)
    `,
    `
      CREATE INDEX idx_signal_watches_target_key
      ON signal_watches (uid, target_process_id, dedupe_key, status)
    `,
    "DELETE FROM group_capabilities WHERE capability = 'app.*' OR capability LIKE 'pkg.%' OR gid IN (SELECT passwd.gid FROM passwd JOIN config_kv ON config_kv.key = 'users/' || passwd.uid || '/pkg/owner')",
    "DELETE FROM processes WHERE uid IN (SELECT passwd.uid FROM passwd JOIN config_kv ON config_kv.key = 'users/' || passwd.uid || '/pkg/owner')",
  ],
};
