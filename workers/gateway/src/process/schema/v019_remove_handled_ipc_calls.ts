import type { SqlMigration } from "../../schema/runner";

/**
 * A call's answers now reach this Process from the Kernel's event log, which delivers
 * each once under its delivery id, so the Process's own list of handled calls goes.
 */
export const PROCESS_V019_REMOVE_HANDLED_IPC_CALLS: SqlMigration = {
  id: 19,
  name: "remove_handled_ipc_calls",
  statements: ["DELETE FROM process_kv WHERE key = 'handledIpcCalls'"],
};
