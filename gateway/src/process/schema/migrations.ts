import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { PROCESS_V001_INITIAL_SCHEMA } from "./v001_initial";
import { PROCESS_V002_MESSAGE_RUN_ID } from "./v002_message_run_id";
import { PROCESS_V003_MESSAGE_METADATA } from "./v003_message_metadata";
import { PROCESS_V004_PENDING_TOOL_DISPATCH_ID } from "./v004_pending_tool_dispatch_id";
import { PROCESS_V005_TOOL_RESULT_OUTCOME } from "./v005_tool_result_outcome";
import { PROCESS_V006_PENDING_HIL_OWNER } from "./v006_pending_hil_owner";

// Used by Process DO startup before ProcessStore reads or writes rows.
export const PROCESS_SCHEMA_COMPONENT = "process";

export const PROCESS_MIGRATIONS: readonly SqlMigration[] = [
  PROCESS_V001_INITIAL_SCHEMA,
  PROCESS_V002_MESSAGE_RUN_ID,
  PROCESS_V003_MESSAGE_METADATA,
  PROCESS_V004_PENDING_TOOL_DISPATCH_ID,
  PROCESS_V005_TOOL_RESULT_OUTCOME,
  PROCESS_V006_PENDING_HIL_OWNER,
];

export function runProcessSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
}
