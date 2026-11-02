import type { SqlMigration } from "../../schema/runner";

/**
 * Rules also say what Ship does about a kind, and notices cover more than contacts.
 * Waking stays with each kind's responsibility source, so `ship` holds only the rest.
 */
export const KERNEL_V089_HAPPENING_RULES: SqlMigration = {
  id: 89,
  name: "happening_rules",
  statements: [
    "ALTER TABLE notice_rules ADD COLUMN ship TEXT CHECK (ship IS NULL OR ship IN ('none', 'context'))",
    `
      CREATE TABLE owner_notices_next (
        notice_key TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        topic TEXT NOT NULL,
        subject_json TEXT NOT NULL,
        pending_count INTEGER NOT NULL,
        counted_sequence INTEGER,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
        round INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER NOT NULL,
        sent_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO owner_notices_next (notice_key, owner_uid, topic, subject_json, pending_count, counted_sequence, state,
        round, attempt_count, last_error, next_attempt_at, sent_at, created_at, updated_at)
      SELECT notice_key, owner_uid, topic, subject_json, pending_count, counted_sequence, state,
        round, attempt_count, last_error, next_attempt_at, sent_at, created_at, updated_at
      FROM owner_notices
    `,
    "DROP TABLE owner_notices",
    "ALTER TABLE owner_notices_next RENAME TO owner_notices",
    "CREATE INDEX owner_notices_due ON owner_notices (owner_uid, state, next_attempt_at)",
  ],
};
