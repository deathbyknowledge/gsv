import type { SqlMigration } from "../../schema/runner";

/**
 * Every Ship names its contacts by DID, so origin details from before DIDs go.
 * A message whose details the move never named keeps its text, but a reply can
 * no longer point to it.
 */
export const CONVERSATION_V009_DROP_ORIGINS_BEFORE_DIDS: SqlMigration = {
  id: 9,
  name: "drop_origins_before_dids",
  statements: [
    "DROP INDEX messages_awaiting_move",
    "ALTER TABLE messages DROP COLUMN legacy_social_json",
    "DROP TABLE message_origins_legacy",
  ],
};
