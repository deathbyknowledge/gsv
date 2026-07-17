import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V009_REGISTER_APP_RUNNERS: SqlMigration = {
  id: 9,
  name: "register_app_runners",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS managed_app_runners (
        runner_name TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        package_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(uid, package_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_managed_app_runners_uid
      ON managed_app_runners(uid, package_id)
    `,
    `
      INSERT OR IGNORE INTO managed_app_runners (
        runner_name,
        uid,
        package_id,
        created_at,
        updated_at
      )
      SELECT
        'app:' || uid || ':' || package_id,
        uid,
        package_id,
        MIN(created_at),
        MAX(COALESCE(last_used_at, created_at))
      FROM app_sessions
      GROUP BY uid, package_id
    `,
  ],
};
