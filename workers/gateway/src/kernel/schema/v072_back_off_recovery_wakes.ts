import type { SqlMigration } from "../../schema/runner";

/** Counts the recovery wakes in a row that left a responsibility untouched, so each waits longer. */
export const KERNEL_V072_BACK_OFF_RECOVERY_WAKES: SqlMigration = {
  id: 72,
  name: "back_off_recovery_wakes",
  statements: [
    "ALTER TABLE responsibilities ADD COLUMN wake_retry_count INTEGER NOT NULL DEFAULT 0",
  ],
};
