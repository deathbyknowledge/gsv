import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V082_OWNER_NOTICES: SqlMigration = {
  id: 82,
  name: "owner_notices",
  statements: [
    `
      CREATE TABLE owner_notices (
        notice_key TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        topic TEXT NOT NULL CHECK (topic IN ('contact.message', 'contact.request', 'contact.invite.accepted')),
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
    "CREATE INDEX owner_notices_due ON owner_notices (owner_uid, state, next_attempt_at)",
  ],
};
