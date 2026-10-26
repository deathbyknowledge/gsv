import type { SqlMigration } from "../../schema/runner";

/**
 * Contacts, blocks and deliveries name the other person by DID. Rows that named
 * a Ship by shipId and subject move to `*_legacy` tables until the operator's
 * move fills in each DID; invitations and pairing attempts issued before DIDs
 * lapse. Release 2 drops the legacy tables once nothing is left to move.
 */
export const KERNEL_V074_CONTACTS_BY_DID: SqlMigration = {
  id: 74,
  name: "contacts_by_did",
  statements: [
    // Renamed tables keep their indexes' names, which the new tables reuse.
    "ALTER TABLE federation_contacts RENAME TO federation_contacts_legacy",
    "DROP INDEX federation_contacts_owner_state_idx",
    `CREATE TABLE federation_contacts (
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
      UNIQUE (owner_uid, remote_did)
    )`,
    `INSERT INTO federation_contacts (
      contact_id, owner_uid, state, generation, remote_did, remote_name, remote_handle, local_alias,
      conversation_id, thread_id, created_at, updated_at, revoked_at, last_received_at, last_delivered_at,
      saved, muted, ship_handles_messages, policy_revision
    ) SELECT
      contact_id, owner_uid, state, generation, NULL, remote_display_name, NULL, local_alias,
      conversation_id, thread_id, created_at, updated_at, revoked_at, last_received_at, last_delivered_at,
      saved, muted, ship_handles_messages, policy_revision
    FROM federation_contacts_legacy`,
    "CREATE INDEX federation_contacts_owner_state_idx ON federation_contacts (owner_uid, state, updated_at DESC)",
    "CREATE INDEX federation_contacts_awaiting_move ON federation_contacts (contact_id) WHERE remote_did IS NULL",

    "ALTER TABLE federation_actor_blocks RENAME TO federation_actor_blocks_legacy",
    `CREATE TABLE federation_actor_blocks (
      owner_uid INTEGER NOT NULL,
      did TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_uid, did)
    )`,

    "ALTER TABLE federation_outbox RENAME TO federation_outbox_legacy",
    "DROP INDEX federation_outbox_pending_idx",
    "DROP INDEX federation_outbox_retention_idx",
    "DROP INDEX federation_outbox_message_sequence",
    `CREATE TABLE federation_outbox (
      delivery_id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      contact_id TEXT NOT NULL,
      contact_generation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      payload_json TEXT,
      preparation_json TEXT,
      resource_count INTEGER NOT NULL DEFAULT 0,
      local_message_json TEXT,
      local_sequence INTEGER,
      state TEXT NOT NULL CHECK (
        state IN ('preparing', 'preparation_failed', 'pending', 'delivered', 'terminal')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      retry_epoch INTEGER NOT NULL DEFAULT 0,
      retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
      CHECK (
        (state IN ('preparing', 'preparation_failed')
          AND preparation_json IS NOT NULL AND payload_json IS NULL)
        OR
        (state IN ('pending', 'delivered', 'terminal')
          AND preparation_json IS NULL AND payload_json IS NOT NULL)
      ),
      CHECK (resource_count >= 0),
      CHECK (state = 'preparing' OR resource_count = 0),
      UNIQUE (owner_uid, idempotency_key)
    )`,
    `CREATE INDEX federation_outbox_pending_idx
      ON federation_outbox (state, next_attempt_at, created_at)
      WHERE state IN ('preparing', 'pending')`,
    `CREATE INDEX federation_outbox_retention_idx
      ON federation_outbox (updated_at)
      WHERE state IN ('preparation_failed', 'delivered', 'terminal')`,
    "CREATE INDEX federation_outbox_message_sequence ON federation_outbox (contact_id, local_sequence) WHERE local_sequence IS NOT NULL",

    "ALTER TABLE federation_inbox RENAME TO federation_inbox_legacy",
    "DROP INDEX federation_inbox_recovery_idx",
    "DROP INDEX federation_inbox_retention_idx",
    `CREATE TABLE federation_inbox (
      contact_id TEXT NOT NULL,
      contact_generation TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('received', 'committed', 'rejected')),
      last_error TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      committed_at INTEGER,
      attention_recorded INTEGER NOT NULL DEFAULT 0 CHECK (attention_recorded IN (0, 1)),
      PRIMARY KEY (contact_id, contact_generation, delivery_id)
    )`,
    `CREATE INDEX federation_inbox_recovery_idx
      ON federation_inbox (state, received_at)
      WHERE state = 'received'`,
    `CREATE INDEX federation_inbox_retention_idx
      ON federation_inbox (updated_at)
      WHERE state IN ('committed', 'rejected')`,

    // Codes issued before DIDs lapse, and message requests no longer borrow invitations.
    "DROP TABLE federation_invites",
    `CREATE TABLE federation_invites (
      invite_id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      ship_handles_messages INTEGER NOT NULL DEFAULT 0 CHECK (ship_handles_messages IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('issued', 'accepted', 'cancelled')),
      expires_at INTEGER NOT NULL,
      cancelled_at INTEGER,
      accepted_contact_id TEXT,
      accepted_remote_did TEXT,
      accepted_generation TEXT,
      accepted_thread_id TEXT,
      accepted_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (
        (state = 'issued'
          AND cancelled_at IS NULL AND accepted_contact_id IS NULL AND accepted_remote_did IS NULL
          AND accepted_generation IS NULL AND accepted_thread_id IS NULL AND accepted_at IS NULL)
        OR
        (state = 'cancelled'
          AND cancelled_at IS NOT NULL AND accepted_contact_id IS NULL AND accepted_remote_did IS NULL
          AND accepted_generation IS NULL AND accepted_thread_id IS NULL AND accepted_at IS NULL)
        OR
        (state = 'accepted'
          AND cancelled_at IS NULL AND accepted_contact_id IS NOT NULL AND accepted_remote_did IS NOT NULL
          AND accepted_generation IS NOT NULL AND accepted_thread_id IS NOT NULL AND accepted_at IS NOT NULL)
      )
    )`,
    "CREATE INDEX federation_invites_owner_idx ON federation_invites (owner_uid, created_at DESC)",
    "CREATE INDEX federation_invites_retention_idx ON federation_invites (state, accepted_at, expires_at, created_at)",

    "DROP TABLE federation_pairing_attempts",
    `CREATE TABLE federation_pairing_attempts (
      token_hash TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      remote_did TEXT NOT NULL,
      ship_handles_messages INTEGER NOT NULL DEFAULT 0 CHECK (ship_handles_messages IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'terminal')),
      contact_id TEXT,
      generation TEXT,
      thread_id TEXT,
      terminal_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (state = 'pending'
          AND contact_id IS NULL AND generation IS NULL AND thread_id IS NULL AND terminal_reason IS NULL)
        OR
        (state = 'committed'
          AND contact_id IS NOT NULL AND generation IS NOT NULL AND thread_id IS NOT NULL AND terminal_reason IS NULL)
        OR
        (state = 'terminal'
          AND contact_id IS NULL AND generation IS NULL AND thread_id IS NULL AND terminal_reason IS NOT NULL)
      )
    )`,
    `CREATE UNIQUE INDEX federation_pairing_attempts_pending_remote_idx
      ON federation_pairing_attempts (owner_uid, remote_did)
      WHERE state = 'pending'`,
    "CREATE INDEX federation_pairing_attempts_retention_idx ON federation_pairing_attempts (state, updated_at)",

    // A wait follows a reply to one of this Ship's own messages, so its author needs no column.
    `CREATE TABLE federation_reply_waits_v074 (
      contact_id TEXT NOT NULL,
      contact_generation TEXT NOT NULL,
      message_id TEXT NOT NULL,
      responsibility_id TEXT NOT NULL,
      PRIMARY KEY (contact_id, contact_generation, message_id)
    )`,
    `INSERT INTO federation_reply_waits_v074 (contact_id, contact_generation, message_id, responsibility_id)
      SELECT contact_id, contact_generation, message_id, responsibility_id FROM federation_reply_waits`,
    "DROP TABLE federation_reply_waits",
    "ALTER TABLE federation_reply_waits_v074 RENAME TO federation_reply_waits",
    "CREATE INDEX federation_reply_wait_responsibility ON federation_reply_waits (responsibility_id)",
  ],
};
