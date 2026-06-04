import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { PROCESS_V001_INITIAL_SCHEMA } from "./v001_initial";

// Used by Process DO startup before ProcessStore reads or writes rows.
export const PROCESS_SCHEMA_COMPONENT = "process";

export const PROCESS_MIGRATIONS: readonly SqlMigration[] = [
  PROCESS_V001_INITIAL_SCHEMA,
];

export function runProcessSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
}
