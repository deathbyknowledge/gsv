import { GsvFailure } from "@gsv/catalog";

export type Migration = { version: number; sql: string };

/** What every Durable Object class reports about itself. */
export type ObjectDescription = { class: string; schema: number };

/**
 * Runs each class's forward-only migrations at the object's first wake. Code older than the object's
 * recorded version refuses to run, so a rollback never reads a schema it doesn't know.
 */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[]): number {
  const latest = migrations.reduce((max, migration, index) => {
    if (migration.version !== index + 1) throw new Error(`Migration ${migration.version} is out of order`);
    return migration.version;
  }, 0);
  storage.sql.exec("CREATE TABLE IF NOT EXISTS _schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
  const recorded = storage.sql.exec<{ version: number }>("SELECT version FROM _schema WHERE id = 1").toArray()[0]?.version ?? 0;
  if (recorded > latest) throw new GsvFailure("unavailable", `This object needs a newer release (schema ${recorded}, code ${latest}).`);
  for (const migration of migrations.slice(recorded)) {
    storage.transactionSync(() => {
      storage.sql.exec(migration.sql);
      storage.sql.exec("INSERT INTO _schema (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version", migration.version);
    });
  }
  return latest;
}
