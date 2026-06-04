import { runSqlMigrations, type SqlMigration } from "../../kernel/schema/runner";
import { APP_RUNNER_V001_INITIAL_SCHEMA } from "./v001_initial";

// Used by AppRunner DO startup before app RPC schedule rows are read or written.
export const APP_RUNNER_SCHEMA_COMPONENT = "app-runner";

export const APP_RUNNER_MIGRATIONS: readonly SqlMigration[] = [
  APP_RUNNER_V001_INITIAL_SCHEMA,
];

export function runAppRunnerSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, APP_RUNNER_SCHEMA_COMPONENT, APP_RUNNER_MIGRATIONS);
}
