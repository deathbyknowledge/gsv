import type { SqlMigration } from "../../schema/runner";

/**
 * AppRunner objects are stable per owner/package, while executable package
 * authority is revision-, entrypoint-, route-, and user-Kernel-generation
 * specific. Existing schedules predate that distinction and cannot safely run.
 */
export const APP_RUNNER_V002_BIND_SCHEDULE_AUTHORITY: SqlMigration = {
  id: 2,
  name: "bind_schedule_authority",
  statements: [
    "ALTER TABLE app_rpc_schedules ADD COLUMN logical_key TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN authority_key TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN owner_uid INTEGER",
    "ALTER TABLE app_rpc_schedules ADD COLUMN owner_username TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN kernel_username TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN kernel_generation INTEGER CHECK (kernel_generation IS NULL OR kernel_generation > 0)",
    "ALTER TABLE app_rpc_schedules ADD COLUMN package_id TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN package_name TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN package_updated_at INTEGER",
    "ALTER TABLE app_rpc_schedules ADD COLUMN artifact_hash TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN entrypoint_name TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN route_base TEXT",
    "ALTER TABLE app_rpc_schedules ADD COLUMN runtime_authority_json TEXT",
    `
      UPDATE app_rpc_schedules
      SET logical_key = schedule_key,
          enabled = 0,
          next_run_at = NULL,
          running_at = NULL,
          last_status = 'error',
          last_error = 'Legacy schedule authority is unbound'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_rpc_schedules_authority
      ON app_rpc_schedules (authority_key, logical_key)
    `,
  ],
};
