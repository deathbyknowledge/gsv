import type { SqlMigration } from "../../schema/runner";

/**
 * Message requests name the other person by DID, and the caller's service auth
 * replaces the setup token, pinned keys and signed receipts. Requests that named
 * a Ship by shipId and subject move to `social_approaches_legacy` until the
 * operator's move fills in each DID.
 */
export const KERNEL_V076_MESSAGE_REQUESTS_BY_DID: SqlMigration = {
  id: 76,
  name: "message_requests_by_did",
  statements: [
    // The renamed table keeps its indexes' names, which the new table reuses.
    "ALTER TABLE social_approaches RENAME TO social_approaches_legacy",
    "DROP INDEX social_approaches_unresolved_peer",
    "DROP INDEX social_approaches_inbox",
    "DROP INDEX social_approaches_cleanup",
    "DROP INDEX social_approaches_expiry",
    "DROP INDEX social_approaches_recovery",
    "DROP INDEX social_approaches_invite",
    "DROP INDEX social_approaches_conversation",
    "DROP INDEX social_approaches_generation",
    `CREATE TABLE social_approaches (
      approach_id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      request_id TEXT NOT NULL,
      remote_did TEXT NOT NULL,
      remote_handle TEXT,
      remote_display_name TEXT NOT NULL,
      local_display_name TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('preparing', 'pending', 'accepting', 'accepted', 'declined', 'withdrawn', 'expired', 'blocked')),
      revision INTEGER NOT NULL DEFAULT 1,
      fingerprint TEXT NOT NULL,
      idempotency_key TEXT,
      profile_cid TEXT,
      message_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      pending_text TEXT,
      pending_text_bytes INTEGER NOT NULL DEFAULT 0,
      message_sequence INTEGER,
      contact_generation TEXT,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('queued', 'received', 'failed', 'unconfirmed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      accepted_at INTEGER,
      ship_handles_messages INTEGER NOT NULL DEFAULT 0 CHECK (ship_handles_messages IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      cleanup_at INTEGER,
      UNIQUE (direction, remote_did, request_id),
      UNIQUE (owner_uid, idempotency_key)
    )`,
    `CREATE UNIQUE INDEX social_approaches_unresolved_peer ON social_approaches (owner_uid, remote_did)
      WHERE state IN ('preparing', 'pending', 'accepting')`,
    "CREATE INDEX social_approaches_inbox ON social_approaches (owner_uid, direction, created_at DESC, approach_id DESC)",
    "CREATE INDEX social_approaches_cleanup ON social_approaches (cleanup_at) WHERE cleanup_at IS NOT NULL",
    "CREATE INDEX social_approaches_expiry ON social_approaches (expires_at) WHERE state IN ('preparing', 'pending')",
    "CREATE INDEX social_approaches_recovery ON social_approaches (next_attempt_at) WHERE next_attempt_at IS NOT NULL",
    "CREATE INDEX social_approaches_conversation ON social_approaches (conversation_id)",
    "CREATE INDEX social_approaches_generation ON social_approaches (contact_id, contact_generation) WHERE contact_generation IS NOT NULL",
  ],
};
