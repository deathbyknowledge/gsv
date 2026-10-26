import type { SqlMigration } from "../../schema/runner";

/**
 * Contact messages name their author's Ship by DID. Origin details written
 * before DIDs named a Ship by shipId and subject; they wait in legacy storage
 * until the operator's move names each DID, and release 2 drops what is left.
 */
export const CONVERSATION_V008_ORIGINS_BY_DID: SqlMigration = {
  id: 8,
  name: "origins_by_did",
  statements: [
    "ALTER TABLE messages ADD COLUMN legacy_social_json TEXT",
    "UPDATE messages SET legacy_social_json = social_json, social_json = NULL WHERE social_json IS NOT NULL",
    "CREATE INDEX messages_awaiting_move ON messages (sequence) WHERE legacy_social_json IS NOT NULL",
    // A contact conversation belongs to one contact, so its authors need no Ship of their own.
    `UPDATE messages SET author_json = json_remove(author_json, '$.shipId', '$.subjectId')
      WHERE json_extract(author_json, '$.kind') = 'contact'`,
    "ALTER TABLE message_origins RENAME TO message_origins_legacy",
    `CREATE TABLE message_origins (
      did TEXT NOT NULL,
      origin_message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      sequence INTEGER NOT NULL UNIQUE,
      PRIMARY KEY (did, origin_message_id, thread_id)
    )`,
  ],
};
