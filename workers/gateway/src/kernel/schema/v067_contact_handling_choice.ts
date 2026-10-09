import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V067_CONTACT_HANDLING_CHOICE: SqlMigration = {
  id: 67,
  name: "contact_handling_choice",
  statements: [
    "ALTER TABLE federation_invites ADD COLUMN ship_handles_messages INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE federation_pairing_attempts ADD COLUMN ship_handles_messages INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE social_approaches ADD COLUMN ship_handles_messages INTEGER NOT NULL DEFAULT 0",
  ],
};
