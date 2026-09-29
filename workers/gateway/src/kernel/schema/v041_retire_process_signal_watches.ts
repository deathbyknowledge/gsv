import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V041_RETIRE_PROCESS_SIGNAL_WATCHES: SqlMigration = {
  id: 41,
  name: "retire_process_signal_watches",
  statements: [
    "DELETE FROM signal_watches WHERE source_target_id IS NULL",
  ],
};
