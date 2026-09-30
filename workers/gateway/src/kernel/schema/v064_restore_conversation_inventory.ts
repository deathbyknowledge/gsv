import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V064_RESTORE_CONVERSATION_INVENTORY: SqlMigration = {
  id: 64,
  name: "restore_conversation_inventory",
  statements: [
    `INSERT OR IGNORE INTO installation_resources(kind, resource_id)
      SELECT 'conversation', conversation_id FROM conversations`,
    `CREATE TRIGGER retain_conversation_resource AFTER INSERT ON conversations BEGIN
      INSERT OR IGNORE INTO installation_resources(kind, resource_id) VALUES ('conversation', NEW.conversation_id);
    END`,
  ],
};
