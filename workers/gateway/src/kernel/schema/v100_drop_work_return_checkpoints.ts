import type { SqlMigration } from "../../schema/runner";

/**
 * A /ship records its return on the event log, keyed by its ingress receipt, instead of in a
 * checkpoint. A command an older Kernel left checkpointed starts afresh when its adapter retries.
 */
export const KERNEL_V100_DROP_WORK_RETURN_CHECKPOINTS: SqlMigration = {
  id: 100,
  name: "drop_work_return_checkpoints",
  statements: [
    `UPDATE adapter_ingress_receipts SET progress_json = NULL
      WHERE state = 'in_progress' AND json_extract(progress_json, '$.kind') = 'work_return'`,
  ],
};
