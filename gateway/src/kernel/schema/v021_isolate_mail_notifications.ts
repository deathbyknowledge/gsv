import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V021_ISOLATE_MAIL_NOTIFICATIONS: SqlMigration = {
  id: 21,
  name: "isolate_mail_notifications",
  statements: [
    `
      ALTER TABLE mailboxes
      ADD COLUMN notification_uid INTEGER
    `,
  ],
};
