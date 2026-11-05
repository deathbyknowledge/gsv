import type { SqlMigration } from "../../schema/runner";

/**
 * Call answers and failed deliveries reach this Process from the Kernel's event log, which
 * delivers each once under its delivery id, so the Process's own records of the ones it
 * handled go.
 */
export const PROCESS_V019_REMOVE_HANDLED_DELIVERIES: SqlMigration = {
  id: 19,
  name: "remove_handled_deliveries",
  statements: [
    "DELETE FROM process_kv WHERE key IN ('handledIpcCalls', 'deliveryNoticeIds') OR key LIKE 'deliveryNotice:%'",
  ],
};
