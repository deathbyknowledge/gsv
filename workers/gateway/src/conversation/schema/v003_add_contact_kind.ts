import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V003_ADD_CONTACT_KIND: SqlMigration = {
  id: 3,
  name: "add_contact_kind",
  statements: [
    `
      CREATE TABLE conversation_meta_v003 (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group', 'contact')),
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO conversation_meta_v003 (conversation_id, owner_uid, kind, created_at)
      SELECT conversation_id, owner_uid, kind, created_at
      FROM conversation_meta
    `,
    "DROP TABLE conversation_meta",
    "ALTER TABLE conversation_meta_v003 RENAME TO conversation_meta",
  ],
};
