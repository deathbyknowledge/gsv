import type { SqlMigration } from "../../schema/runner";

/**
 * Maps a messenger's id for a message to the canonical message it carried, so a
 * quoted reply can name what it quotes. Rows hold references, never message text.
 * Ids run in write order, so pruning walks the oldest rows without a time index.
 */
export const KERNEL_V086_ADAPTER_MESSAGE_REFS: SqlMigration = {
  id: 86,
  name: "adapter_message_refs",
  statements: [
    `
      CREATE TABLE adapter_message_refs (
        id INTEGER PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        adapter TEXT NOT NULL,
        account_id TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE UNIQUE INDEX adapter_message_refs_scope ON adapter_message_refs (
        owner_uid, adapter, account_id, surface_kind, surface_id, thread_id, provider_message_id
      )
    `,
  ],
};
