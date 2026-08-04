export type SqlMigration = {
  id: number;
  name: string;
  statements: readonly string[];
};

type AppliedMigration = {
  component: string;
  id: number;
  name: string;
  checksum: string;
};

const MIGRATIONS_TABLE = "_gsv_schema_migrations";

export function runSqlMigrations(
  storage: DurableObjectStorage,
  component: string,
  migrations: readonly SqlMigration[],
): void {
  validateMigrations(migrations);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      component  TEXT    NOT NULL,
      id         INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (component, id)
    )
  `);
  const applied = new Map(
    storage.sql.exec<AppliedMigration>(
      `SELECT component, id, name, checksum
       FROM ${MIGRATIONS_TABLE}
       WHERE component = ?
       ORDER BY id`,
      component,
    ).toArray().map((migration) => [migration.id, migration]),
  );

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration);
    const existing = applied.get(migration.id);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(
          `Schema migration ${component}:${migration.id} has changed after being applied`,
        );
      }
      continue;
    }
    storage.transactionSync(() => {
      for (const statement of migration.statements) {
        if (statement.trim()) storage.sql.exec(statement.trim());
      }
      storage.sql.exec(
        `INSERT INTO ${MIGRATIONS_TABLE} (
           component, id, name, checksum, applied_at
         ) VALUES (?, ?, ?, ?, ?)`,
        component,
        migration.id,
        migration.name,
        checksum,
        Date.now(),
      );
    });
  }
}

function validateMigrations(migrations: readonly SqlMigration[]): void {
  let previousId = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.id) || migration.id <= previousId) {
      throw new Error(`Schema migrations must have ascending positive ids: ${migration.id}`);
    }
    if (!migration.name.trim()) {
      throw new Error(`Schema migration ${migration.id} is missing a name`);
    }
    previousId = migration.id;
  }
}

function migrationChecksum(migration: SqlMigration): string {
  const input = JSON.stringify({
    id: migration.id,
    name: migration.name,
    statements: migration.statements.map((statement) => statement.trim()),
  });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
