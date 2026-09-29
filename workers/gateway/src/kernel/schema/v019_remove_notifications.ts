import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V019_REMOVE_NOTIFICATIONS: SqlMigration = {
  id: 19,
  name: "remove_notifications",
  statements: [
    "DELETE FROM group_capabilities WHERE capability LIKE 'notification.%'",
    "DELETE FROM signal_watches WHERE signal LIKE 'notification.%'",
    "DROP TABLE notifications",
  ],
};
