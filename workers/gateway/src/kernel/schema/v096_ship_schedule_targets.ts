import type { SqlMigration } from "../../schema/runner";

/**
 * A schedule aimed at a Ship's pid becomes the Ship responsibility new ones are stored
 * as, so every firing for a process goes on the event log. Its reply destination goes:
 * the Ship replies where its owner last spoke.
 */
export const KERNEL_V096_SHIP_SCHEDULE_TARGETS: SqlMigration = {
  id: 96,
  name: "ship_schedule_targets",
  statements: [
    `
      UPDATE schedules
      SET target_json = CASE
        WHEN json_type(target_json, '$.data') IS NULL
          THEN json_object('kind', 'responsibility', 'message', json_extract(target_json, '$.message'))
        ELSE json_object('kind', 'responsibility', 'message', json_extract(target_json, '$.message'), 'data', target_json -> '$.data')
      END
      WHERE json_extract(target_json, '$.kind') = 'process.event'
        AND json_extract(target_json, '$.pid') IN (SELECT process_id FROM processes WHERE is_personal_controller = 1)
    `,
  ],
};
