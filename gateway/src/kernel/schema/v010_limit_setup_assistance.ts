import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V010_LIMIT_SETUP_ASSISTANCE: SqlMigration = {
  id: 10,
  name: "limit_setup_assistance",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS setup_assist_usage (
        scope INTEGER PRIMARY KEY CHECK (scope = 1),
        hourly_window_started_at INTEGER NOT NULL,
        hourly_requests INTEGER NOT NULL,
        daily_window_started_at INTEGER NOT NULL,
        daily_requests INTEGER NOT NULL
      )
    `,
  ],
};
