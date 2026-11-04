import type { SqlMigration } from "../../schema/runner";

/**
 * A failed delivery now reaches this Process from the Kernel's event log, which delivers
 * each once under its delivery id, so the Process's own notice tombstones go.
 */
export const PROCESS_V020_REMOVE_DELIVERY_NOTICE_TOMBSTONES: SqlMigration = {
  id: 20,
  name: "remove_delivery_notice_tombstones",
  statements: ["DELETE FROM process_kv WHERE key = 'deliveryNoticeIds' OR key LIKE 'deliveryNotice:%'"],
};
