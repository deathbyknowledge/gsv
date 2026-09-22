import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V062_RETRY_CONTACT_MESSAGES: SqlMigration = {
  id: 62,
  name: "retry_contact_messages",
  statements: [
    "CREATE INDEX federation_outbox_message_sequence ON federation_outbox (contact_id, local_sequence) WHERE local_sequence IS NOT NULL",
    "ALTER TABLE federation_outbox ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE federation_outbox ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1))",
  ],
};
