import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V063_CONTACT_REPLY_CONTINUATIONS: SqlMigration = {
  id: 63,
  name: "contact_reply_continuations",
  statements: [
    "ALTER TABLE federation_inbox ADD COLUMN attention_recorded INTEGER NOT NULL DEFAULT 0 CHECK (attention_recorded IN (0, 1))",
    `CREATE TABLE federation_reply_waits (
      contact_id TEXT NOT NULL,
      contact_generation TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ship_id TEXT,
      subject_id TEXT,
      responsibility_id TEXT NOT NULL,
      PRIMARY KEY (contact_id, contact_generation, message_id)
    )`,
    "CREATE INDEX federation_reply_wait_responsibility ON federation_reply_waits (responsibility_id)",
  ],
};
