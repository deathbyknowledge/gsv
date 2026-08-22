import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { CONVERSATION_V001_INITIAL_SCHEMA } from "./v001_initial";

export const CONVERSATION_SCHEMA_COMPONENT = "conversation";

export const CONVERSATION_MIGRATIONS: readonly SqlMigration[] = [
  CONVERSATION_V001_INITIAL_SCHEMA,
];

export function runConversationSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, CONVERSATION_MIGRATIONS);
}
