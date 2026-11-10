import type { SqlMigration } from "../../schema/runner";

/**
 * An outgoing message request keeps its sender's choice to save the person as
 * a contact once it is accepted. Earlier requests keep today's unsaved contact.
 */
export const KERNEL_V094_REQUEST_SAVE_CONTACT: SqlMigration = {
  id: 94,
  name: "request_save_contact",
  statements: [
    "ALTER TABLE social_approaches ADD COLUMN save_contact INTEGER NOT NULL DEFAULT 0 CHECK (save_contact IN (0, 1))",
  ],
};
