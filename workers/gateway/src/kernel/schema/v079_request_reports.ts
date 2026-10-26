import type { SqlMigration } from "../../schema/runner";

/** When the person reported an incoming message request to their operator. */
export const KERNEL_V079_REQUEST_REPORTS: SqlMigration = {
  id: 79,
  name: "request_reports",
  statements: [
    "ALTER TABLE social_approaches ADD COLUMN reported_at INTEGER",
  ],
};
