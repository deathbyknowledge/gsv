import type { SqlMigration } from "../../schema/runner";

/**
 * Settling a memory review admits the next waiting one in the same transaction, and the
 * Kernel's start admits one an older Kernel left waiting, so the per-owner poll goes.
 */
export const KERNEL_V099_REMOVE_MEMORY_REVIEW_POLL: SqlMigration = {
  id: 99,
  name: "remove_memory_review_poll",
  statements: [
    "DELETE FROM cf_agents_schedules WHERE callback = 'onMemoryReview'",
  ],
};
