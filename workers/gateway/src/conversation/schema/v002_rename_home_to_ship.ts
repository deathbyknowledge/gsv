import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V002_RENAME_HOME_TO_SHIP: SqlMigration = {
  id: 2,
  name: "rename_home_to_ship",
  statements: [
    `
      CREATE TABLE conversation_meta_v002 (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group')),
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO conversation_meta_v002 (conversation_id, owner_uid, kind, created_at)
      SELECT
        conversation_id,
        owner_uid,
        CASE kind WHEN 'home' THEN 'ship' ELSE kind END,
        created_at
      FROM conversation_meta
    `,
    "DROP TABLE conversation_meta",
    "ALTER TABLE conversation_meta_v002 RENAME TO conversation_meta",
  ],
};
