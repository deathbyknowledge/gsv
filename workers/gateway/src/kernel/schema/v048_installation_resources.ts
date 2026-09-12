import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V048_INSTALLATION_RESOURCES: SqlMigration = {
  id: 48,
  name: "retain_installation_resources",
  statements: [
    `CREATE TABLE installation_resources (
      kind TEXT NOT NULL CHECK(kind IN ('process', 'conversation')),
      resource_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live', 'quiesced', 'live-erased')),
      PRIMARY KEY(kind, resource_id)
    )`,
    `INSERT INTO installation_resources(kind, resource_id) SELECT 'process', process_id FROM processes`,
    `INSERT INTO installation_resources(kind, resource_id) SELECT 'conversation', conversation_id FROM conversations`,
    `CREATE TRIGGER retain_process_resource BEFORE INSERT ON processes BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM installation_resources WHERE kind = 'process' AND resource_id = NEW.process_id)
        THEN RAISE(ABORT, 'Process identity must never be reused') END;
      INSERT INTO installation_resources(kind, resource_id) VALUES ('process', NEW.process_id);
    END`,
    `CREATE TRIGGER retain_conversation_resource AFTER INSERT ON conversations BEGIN
      INSERT OR IGNORE INTO installation_resources(kind, resource_id) VALUES ('conversation', NEW.conversation_id);
    END`,
  ],
};
