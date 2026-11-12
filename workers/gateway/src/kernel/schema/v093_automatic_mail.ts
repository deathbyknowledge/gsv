import type { SqlMigration } from "../../schema/runner";

/**
 * Received mail records whether it was an automatic reply or a delivery
 * report, which the Ship isn't asked to review. Earlier mail stays null.
 */
export const KERNEL_V093_AUTOMATIC_MAIL: SqlMigration = {
  id: 93,
  name: "automatic_mail",
  statements: [
    "ALTER TABLE mail_messages ADD COLUMN automatic TEXT",
  ],
};
