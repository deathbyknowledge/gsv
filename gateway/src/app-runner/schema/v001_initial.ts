import type { SqlMigration } from "../../kernel/schema/runner";

// Current AppRunner Durable Object SQLite schema for fresh v1 installations.
export const APP_RUNNER_V001_INITIAL_SCHEMA: SqlMigration = {
  id: 1,
  name: "initial_app_runner_schema",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS app_rpc_schedules (
        schedule_key     TEXT PRIMARY KEY,
        rpc_method       TEXT NOT NULL,
        schedule_json    TEXT NOT NULL,
        payload_json     TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        version          INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        next_run_at      INTEGER,
        running_at       INTEGER,
        last_run_at      INTEGER,
        last_status      TEXT,
        last_error       TEXT,
        last_duration_ms INTEGER
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_app_rpc_schedules_due
      ON app_rpc_schedules (enabled, next_run_at, schedule_key)
    `,
  ],
};
