import type { SqlMigration } from "../../schema/runner";

/**
 * Every Ship names its contacts by DID, so the rows from before DIDs go and an
 * active contact must name one. A contact that ended before DIDs keeps its
 * conversation without one. On a Ship the move never reached, contacts from
 * before DIDs end here as the move ended one it couldn't name, and its waiting
 * deliveries, requests and blocks from before DIDs go with the legacy tables.
 */
export const KERNEL_V077_DROP_CONTACTS_BEFORE_DIDS: SqlMigration = {
  id: 77,
  name: "drop_contacts_before_dids",
  statements: [
    `UPDATE federation_contacts SET
      state = 'revoked', revoked_at = unixepoch() * 1000, updated_at = unixepoch() * 1000,
      ship_handles_messages = 0, policy_revision = policy_revision + 1
    WHERE state = 'active' AND remote_did IS NULL`,
    `DELETE FROM federation_resource_grants
      WHERE contact_id IN (SELECT contact_id FROM federation_contacts WHERE remote_did IS NULL)`,

    "DROP TABLE federation_contacts_legacy",
    "DROP TABLE federation_actor_blocks_legacy",
    "DROP TABLE federation_outbox_legacy",
    "DROP TABLE federation_inbox_legacy",
    "DROP TABLE social_approaches_legacy",
    "DROP TABLE federation_subjects",

    `CREATE TABLE federation_contacts_v077 (
      contact_id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
      generation TEXT NOT NULL,
      remote_did TEXT,
      remote_name TEXT NOT NULL,
      remote_handle TEXT,
      local_alias TEXT,
      conversation_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_received_at INTEGER,
      last_delivered_at INTEGER,
      saved INTEGER NOT NULL DEFAULT 1 CHECK (saved IN (0, 1)),
      muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
      ship_handles_messages INTEGER NOT NULL DEFAULT 0 CHECK (ship_handles_messages IN (0, 1)),
      policy_revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE (owner_uid, remote_did),
      CHECK (state = 'revoked' OR remote_did IS NOT NULL)
    )`,
    `INSERT INTO federation_contacts_v077 (
      contact_id, owner_uid, state, generation, remote_did, remote_name, remote_handle, local_alias,
      conversation_id, thread_id, created_at, updated_at, revoked_at, last_received_at, last_delivered_at,
      saved, muted, ship_handles_messages, policy_revision
    ) SELECT
      contact_id, owner_uid, state, generation, remote_did, remote_name, remote_handle, local_alias,
      conversation_id, thread_id, created_at, updated_at, revoked_at, last_received_at, last_delivered_at,
      saved, muted, ship_handles_messages, policy_revision
    FROM federation_contacts`,
    "DROP TABLE federation_contacts",
    "ALTER TABLE federation_contacts_v077 RENAME TO federation_contacts",
    "CREATE INDEX federation_contacts_owner_state_idx ON federation_contacts (owner_uid, state, updated_at DESC)",
  ],
};
