import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V033_ADD_FEDERATION: SqlMigration = {
  id: 33,
  name: "add_federation",
  statements: [
    `
      CREATE TABLE conversations_v033 (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group', 'contact')),
        title TEXT,
        handler_pid TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO conversations_v033 (
        conversation_id, owner_uid, kind, title, handler_pid,
        latest_sequence, created_at, updated_at
      )
      SELECT
        conversation_id, owner_uid, kind, title, handler_pid,
        latest_sequence, created_at, updated_at
      FROM conversations
    `,
    "DROP TABLE conversations",
    "ALTER TABLE conversations_v033 RENAME TO conversations",
    `
      CREATE UNIQUE INDEX conversations_ship_owner_idx
      ON conversations (owner_uid)
      WHERE kind = 'ship'
    `,
    `
      CREATE UNIQUE INDEX conversations_handler_work_idx
      ON conversations (handler_pid)
      WHERE kind = 'work'
    `,
    `
      CREATE TABLE federation_subjects (
        owner_uid INTEGER PRIMARY KEY,
        subject_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE federation_invites (
        invite_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        issuing_ship_id TEXT NOT NULL,
        issuing_origin TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('issued', 'accepted', 'cancelled')),
        expires_at INTEGER NOT NULL,
        cancelled_at INTEGER,
        accepted_contact_id TEXT,
        accepted_remote_ship_id TEXT,
        accepted_remote_subject_id TEXT,
        accepted_generation TEXT,
        accepted_thread_id TEXT,
        accepted_response_json TEXT,
        accepted_at INTEGER,
        created_at INTEGER NOT NULL,
        CHECK (
          (state = 'issued'
            AND cancelled_at IS NULL
            AND accepted_contact_id IS NULL
            AND accepted_remote_ship_id IS NULL
            AND accepted_remote_subject_id IS NULL
            AND accepted_generation IS NULL
            AND accepted_thread_id IS NULL
            AND accepted_response_json IS NULL
            AND accepted_at IS NULL)
          OR
          (state = 'cancelled'
            AND cancelled_at IS NOT NULL
            AND accepted_contact_id IS NULL
            AND accepted_remote_ship_id IS NULL
            AND accepted_remote_subject_id IS NULL
            AND accepted_generation IS NULL
            AND accepted_thread_id IS NULL
            AND accepted_response_json IS NULL
            AND accepted_at IS NULL)
          OR
          (state = 'accepted'
            AND cancelled_at IS NULL
            AND accepted_contact_id IS NOT NULL
            AND accepted_remote_ship_id IS NOT NULL
            AND accepted_remote_subject_id IS NOT NULL
            AND accepted_generation IS NOT NULL
            AND accepted_thread_id IS NOT NULL
            AND accepted_response_json IS NOT NULL
            AND accepted_at IS NOT NULL)
        )
      )
    `,
    `
      CREATE INDEX federation_invites_owner_idx
      ON federation_invites (owner_uid, created_at DESC)
    `,
    `
      CREATE INDEX federation_invites_retention_idx
      ON federation_invites (state, accepted_at, expires_at, created_at)
    `,
    `
      CREATE TABLE federation_pairing_attempts (
        token_hash TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        remote_ship_id TEXT NOT NULL,
        remote_subject_id TEXT NOT NULL,
        remote_origin TEXT NOT NULL,
        remote_public_key_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'terminal')),
        contact_id TEXT,
        generation TEXT,
        thread_id TEXT,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'pending'
            AND contact_id IS NULL
            AND generation IS NULL
            AND thread_id IS NULL
            AND terminal_reason IS NULL)
          OR
          (state = 'committed'
            AND contact_id IS NOT NULL
            AND generation IS NOT NULL
            AND thread_id IS NOT NULL
            AND terminal_reason IS NULL)
          OR
          (state = 'terminal'
            AND contact_id IS NULL
            AND generation IS NULL
            AND thread_id IS NULL
            AND terminal_reason IS NOT NULL)
        )
      )
    `,
    `
      CREATE UNIQUE INDEX federation_pairing_attempts_pending_remote_idx
      ON federation_pairing_attempts (owner_uid, remote_ship_id, remote_subject_id)
      WHERE state = 'pending'
    `,
    `
      CREATE INDEX federation_pairing_attempts_retention_idx
      ON federation_pairing_attempts (state, updated_at)
    `,
    `
      CREATE TABLE federation_contacts (
        contact_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        generation TEXT NOT NULL,
        remote_ship_id TEXT NOT NULL,
        remote_subject_id TEXT NOT NULL,
        remote_display_name TEXT NOT NULL,
        remote_origin TEXT NOT NULL,
        remote_public_key_json TEXT NOT NULL,
        shared_secret TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_received_at INTEGER,
        last_delivered_at INTEGER,
        UNIQUE (owner_uid, remote_ship_id, remote_subject_id)
      )
    `,
    `
      CREATE INDEX federation_contacts_owner_state_idx
      ON federation_contacts (owner_uid, state, updated_at DESC)
    `,
    `
      CREATE TABLE federation_outbox (
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
      )
    `,
    `
      CREATE INDEX federation_outbox_pending_idx
      ON federation_outbox (state, next_attempt_at, created_at)
      WHERE state IN ('preparing', 'pending')
    `,
    `
      CREATE INDEX federation_outbox_retention_idx
      ON federation_outbox (updated_at)
      WHERE state IN ('preparation_failed', 'delivered', 'terminal')
    `,
    `
      CREATE TABLE federation_inbox (
        contact_id TEXT NOT NULL,
        contact_generation TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('received', 'committed', 'rejected')),
        response_json TEXT,
        last_error TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        committed_at INTEGER,
        PRIMARY KEY (contact_id, contact_generation, delivery_id)
      )
    `,
    `
      CREATE INDEX federation_inbox_recovery_idx
      ON federation_inbox (state, received_at)
      WHERE state = 'received'
    `,
    `
      CREATE INDEX federation_inbox_retention_idx
      ON federation_inbox (updated_at)
      WHERE state IN ('committed', 'rejected')
    `,
    `
      CREATE TABLE federation_resource_grants (
        resource_id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        contact_generation TEXT NOT NULL,
        source_ref_json TEXT NOT NULL,
        source_uid INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX federation_resource_grants_contact_idx
      ON federation_resource_grants (contact_id, contact_generation)
    `,
    `
      CREATE TABLE federation_requests (
        request_id TEXT PRIMARY KEY,
        remote_request_id TEXT,
        contact_id TEXT NOT NULL,
        contact_generation TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        details_json TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('offered', 'accepted', 'rejected', 'active', 'completed', 'cancelled')
        ),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX federation_requests_contact_idx
      ON federation_requests (contact_id, contact_generation, state, updated_at DESC)
    `,
    `
      CREATE INDEX federation_requests_retention_idx
      ON federation_requests (updated_at)
      WHERE state IN ('rejected', 'completed', 'cancelled')
    `,
    `
      CREATE UNIQUE INDEX federation_requests_remote_idx
      ON federation_requests (contact_id, contact_generation, direction, remote_request_id)
      WHERE remote_request_id IS NOT NULL
    `,
    `
      CREATE TABLE federation_rate_limits (
        scope TEXT NOT NULL,
        operation TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (scope, operation)
      )
    `,
    `
      CREATE INDEX federation_rate_limits_retention_idx
      ON federation_rate_limits (window_started_at)
    `,
    `
      CREATE TABLE federation_resource_reads (
        read_id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        contact_generation TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX federation_resource_reads_contact_idx
      ON federation_resource_reads (contact_id, contact_generation, expires_at)
    `,
  ],
};
