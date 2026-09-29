import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V012_ADD_SCHEDULE_ATTEMPT_COUNT: SqlMigration = {
  id: 12,
  name: "add_schedule_attempt_count",
  statements: [
    `
      ALTER TABLE schedules
        ADD COLUMN one_shot_attempt_count INTEGER NOT NULL DEFAULT 0
    `,
  ],
};
