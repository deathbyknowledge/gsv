/** A versioned change to tables the host owns; the engine keeps its own initSchema. */
export type HostMigration = {
  id: number;
  statements: readonly string[];
};

/** Applies each migration of a component once, in order, in one transaction. */
export function migrate(storage: DurableObjectStorage, component: string, migrations: readonly HostMigration[]): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS host_schema (component TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (component, id))",
    );
    const applied = new Set(storage.sql.exec<{ id: number }>(
      "SELECT id FROM host_schema WHERE component = ?",
      component,
    ).toArray().map((row) => row.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO host_schema (component, id) VALUES (?, ?)", component, migration.id);
    }
  });
}
