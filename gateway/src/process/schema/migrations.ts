import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { PROCESS_V001_INITIAL_SCHEMA } from "./v001_initial";
import { PROCESS_V002_MESSAGE_RUN_ID } from "./v002_message_run_id";

// Used by Process DO startup before ProcessStore reads or writes rows.
export const PROCESS_SCHEMA_COMPONENT = "process";

export const PROCESS_MIGRATIONS: readonly SqlMigration[] = [
  PROCESS_V001_INITIAL_SCHEMA,
  PROCESS_V002_MESSAGE_RUN_ID,
];

export function runProcessSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
}
