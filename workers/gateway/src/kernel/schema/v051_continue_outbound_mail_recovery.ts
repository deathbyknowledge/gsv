import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V051_CONTINUE_OUTBOUND_MAIL_RECOVERY: SqlMigration = {
  id: 51,
  name: "continue_outbound_mail_recovery",
  statements: [
    "DROP INDEX idx_mail_outbound_enqueue",
    `CREATE INDEX idx_mail_outbound_enqueue
     ON mail_outbound(enqueue_next_at, created_at)
     WHERE state = 'queued'`,
  ],
};
