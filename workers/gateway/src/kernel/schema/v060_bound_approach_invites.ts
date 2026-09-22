import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V060_BOUND_APPROACH_INVITES: SqlMigration = {
  id: 60,
  name: "bound_approach_invites",
  statements: [
    "ALTER TABLE federation_invites ADD COLUMN purpose TEXT NOT NULL DEFAULT 'private' CHECK (purpose IN ('private', 'approach'))",
    "CREATE INDEX social_approaches_conversation ON social_approaches (conversation_id)",
    "CREATE INDEX social_approaches_generation ON social_approaches (contact_id, contact_generation) WHERE contact_generation IS NOT NULL",
  ],
};
