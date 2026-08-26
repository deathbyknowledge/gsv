import { runSqlMigrations, type SqlMigration } from "../../schema/runner";
import { CONVERSATION_V001_INITIAL_SCHEMA } from "./v001_initial";
import { CONVERSATION_V002_RENAME_HOME_TO_SHIP } from "./v002_rename_home_to_ship";
import { CONVERSATION_V003_ADD_CONTACT_KIND } from "./v003_add_contact_kind";

export const CONVERSATION_SCHEMA_COMPONENT = "conversation";

export const CONVERSATION_MIGRATIONS: readonly SqlMigration[] = [
  CONVERSATION_V001_INITIAL_SCHEMA,
  CONVERSATION_V002_RENAME_HOME_TO_SHIP,
  CONVERSATION_V003_ADD_CONTACT_KIND,
];

export function runConversationSqlMigrations(storage: DurableObjectStorage): void {
  runSqlMigrations(storage, CONVERSATION_SCHEMA_COMPONENT, CONVERSATION_MIGRATIONS);
}
