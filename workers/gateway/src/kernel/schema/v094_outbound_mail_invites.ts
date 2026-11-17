import type { SqlMigration } from "../../schema/runner";

/**
 * Outbound mail can carry a calendar invite: its iTIP method and iCalendar
 * text, both null for a message without one.
 */
export const KERNEL_V094_OUTBOUND_MAIL_INVITES: SqlMigration = {
  id: 94,
  name: "outbound_mail_invites",
  statements: [
    "ALTER TABLE mail_outbound ADD COLUMN invite_method TEXT",
    "ALTER TABLE mail_outbound ADD COLUMN invite_text TEXT",
  ],
};
