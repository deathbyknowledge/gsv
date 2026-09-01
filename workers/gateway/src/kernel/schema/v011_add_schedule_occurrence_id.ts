import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V011_ADD_SCHEDULE_OCCURRENCE_ID: SqlMigration = {
  id: 11,
  name: "add_schedule_occurrence_id",
  statements: [
    `
      ALTER TABLE schedules ADD COLUMN one_shot_occurrence_id TEXT
    `,
    // Preserve one logical occurrence for an armed legacy one-shot. Disabled
    // terminal rows remain NULL so a later user re-arm receives a fresh id.
    `
      UPDATE schedules
         SET one_shot_occurrence_id = 'legacy:' || schedule_id
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND json_extract(expression_json, '$.kind') IN ('at', 'after')
    `,
  ],
};
