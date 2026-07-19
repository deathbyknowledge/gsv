import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V014_INTERNALIZE_CONVERSATION_ARCHIVES: SqlMigration = {
  id: 14,
  name: "internalize_conversation_archives",
  statements: [
    // Legacy pointers identify agent-owned files in a shared account home.
    // Fail closed: a fresh owner-bound executor will create a new private path.
    "UPDATE conversations SET latest_archive = NULL",
    "ALTER TABLE conversations DROP COLUMN archive_base",
  ],
};
