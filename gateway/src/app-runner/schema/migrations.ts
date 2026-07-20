import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { APP_RUNNER_V001_INITIAL_SCHEMA } from "./v001_initial";
import { APP_RUNNER_V002_BIND_SCHEDULE_AUTHORITY } from "./v002_bind_schedule_authority";

// Used by AppRunner DO startup before app RPC schedule rows are read or written.
export const APP_RUNNER_SCHEMA_COMPONENT = "app-runner";

export const APP_RUNNER_MIGRATIONS: readonly SqlMigration[] = [
  APP_RUNNER_V001_INITIAL_SCHEMA,
  APP_RUNNER_V002_BIND_SCHEDULE_AUTHORITY,
];

export function runAppRunnerSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, APP_RUNNER_SCHEMA_COMPONENT, APP_RUNNER_MIGRATIONS);
}
