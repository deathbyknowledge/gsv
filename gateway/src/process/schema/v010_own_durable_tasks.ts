import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V010_OWN_DURABLE_TASKS: SqlMigration = {
  id: 10,
  name: "own_durable_tasks",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS cf_agents_schedules (
        id TEXT PRIMARY KEY NOT NULL,
        callback TEXT NOT NULL,
        payload TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
        time INTEGER,
        delayInSeconds INTEGER,
        cron TEXT,
        intervalSeconds INTEGER,
        running INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        execution_started_at INTEGER,
        retry_options TEXT,
        owner_path TEXT,
        owner_path_key TEXT
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS cf_agents_schedules_time_idx
      ON cf_agents_schedules (time)
    `,
  ],
};
