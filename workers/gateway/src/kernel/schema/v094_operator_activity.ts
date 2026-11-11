import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V094_OPERATOR_ACTIVITY: SqlMigration = {
  id: 94,
  name: "operator_activity",
  statements: [
    `CREATE TABLE operator_activity_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), tracked_from INTEGER NOT NULL)`,
    `INSERT INTO operator_activity_epoch VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)`,
    `CREATE TABLE operator_owner_requests (
      run_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL,
      finished_at INTEGER, outcome TEXT CHECK (outcome IN ('ok', 'error', 'aborted'))
    )`,
    `CREATE INDEX operator_owner_requests_received ON operator_owner_requests(received_at)`,
  ],
};
