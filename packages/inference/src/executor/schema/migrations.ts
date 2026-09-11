import { EXECUTOR_V001_INITIAL } from "./v001_initial";

import { EXECUTOR_V002_RETIREMENT } from "./v002_retirement";

export const EXECUTOR_MIGRATIONS = [EXECUTOR_V001_INITIAL, EXECUTOR_V002_RETIREMENT] as const;

/** Request and counter schema has its own version history in both deployments. */
export function migrateExecutor(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_schema (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL
  )`);
  for (const migration of EXECUTOR_MIGRATIONS) {
    const definition = JSON.stringify(migration.statements);
    const applied = storage.sql.exec<{ name: string; definition: string }>(
      "SELECT name, definition FROM executor_schema WHERE id = ?", migration.id,
    ).toArray()[0];
    if (applied) {
      if (applied.name !== migration.name || applied.definition !== definition) {
        throw new Error(`Executor migration ${migration.id} changed after application`);
      }
      continue;
    }
    storage.transactionSync(() => {
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO executor_schema VALUES (?, ?, ?)", migration.id, migration.name, definition);
    });
  }
}
