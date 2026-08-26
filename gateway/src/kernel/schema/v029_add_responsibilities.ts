import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V029_ADD_RESPONSIBILITIES: SqlMigration = {
  id: 29,
  name: "add_responsibilities",
  statements: [
    `
      CREATE TABLE responsibility_ledgers (
        owner_uid INTEGER PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        wake_generation INTEGER NOT NULL DEFAULT 0,
        wake_task_id TEXT,
        wake_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE responsibilities (
        responsibility_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        details_json TEXT,
        source_json TEXT NOT NULL,
        audience_json TEXT,
        assignee_kind TEXT NOT NULL CHECK (assignee_kind IN ('ship', 'process')),
        assignee_pid TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'active', 'waiting', 'resolved', 'cancelled')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
        due_at INTEGER,
        due_woken_at INTEGER,
        next_check_at INTEGER,
        check_woken_at INTEGER,
        blocker TEXT,
        lease_expires_at INTEGER,
        lease_woken_at INTEGER,
        dedupe_key TEXT,
        resolution_json TEXT,
        change_pending INTEGER NOT NULL DEFAULT 0 CHECK (change_pending IN (0, 1)),
        wake_retry_at INTEGER,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        CHECK (
          (assignee_kind = 'ship' AND assignee_pid IS NULL)
          OR (assignee_kind = 'process' AND assignee_pid IS NOT NULL)
        )
      )
    `,
    `
      CREATE INDEX responsibilities_owner_state_idx
      ON responsibilities (owner_uid, state, priority, updated_at)
    `,
    `
      CREATE INDEX responsibilities_owner_wake_idx
      ON responsibilities (
        owner_uid, change_pending, wake_retry_at, next_check_at, due_at, lease_expires_at
      )
      WHERE state NOT IN ('resolved', 'cancelled') OR change_pending = 1
    `,
    `
      CREATE UNIQUE INDEX responsibilities_owner_dedupe_idx
      ON responsibilities (owner_uid, dedupe_key)
      WHERE dedupe_key IS NOT NULL
    `,
    `
      CREATE TABLE responsibility_transitions (
        owner_uid INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        responsibility_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'resolved', 'cancelled')),
        before_state TEXT,
        after_state TEXT NOT NULL,
        assignee_pid TEXT,
        before_assignee_pid TEXT,
        changed_fields_json TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_uid, revision)
      )
    `,
    `
      CREATE INDEX responsibility_transitions_record_idx
      ON responsibility_transitions (responsibility_id, revision)
    `,
    `
      CREATE INDEX responsibility_transitions_assignee_idx
      ON responsibility_transitions (owner_uid, assignee_pid, before_assignee_pid, revision)
    `,
    `
      CREATE TABLE responsibility_wake_batches (
        batch_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        through_revision INTEGER NOT NULL,
        responsibility_ids_json TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_uid)
      )
    `,
  ],
};
