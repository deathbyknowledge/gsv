import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V018_REMOVE_CONVERSATION_REGISTRY: SqlMigration = {
  id: 18,
  name: "remove_conversation_registry",
  statements: [
    "DROP TABLE conversations",
    "ALTER TABLE processes DROP COLUMN active_conversation_id",
  ],
};
