export type SqlMigration = {
  id: number;
  name: string;
  statements: readonly string[];
};

export type AppliedSqlMigration = {
  component: string;
  id: number;
  name: string;
  checksum: string;
  applied_at: number;
};

export type SqlMigrationStorage =
  | SqlStorage
  | {
      sql: SqlStorage;
      transactionSync<T>(closure: () => T): T;
    };

const MIGRATIONS_TABLE = "_gsv_schema_migrations";

export function runSqlMigrations(
  storage: SqlMigrationStorage,
  component: string,
  migrations: readonly SqlMigration[],
): void {
  validateMigrations(migrations);
  const sql = resolveSql(storage);
  ensureMigrationTable(sql);

  const appliedRows = sql.exec<AppliedSqlMigration>(
    `SELECT component, id, name, checksum, applied_at
     FROM ${MIGRATIONS_TABLE}
     WHERE component = ?
     ORDER BY id`,
    component,
  ).toArray();
  const applied = new Map(appliedRows.map((row) => [row.id, row]));

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

    applyMigration(storage, sql, component, migration, checksum);
  }
}

export function listAppliedSqlMigrations(
  storage: SqlMigrationStorage,
  component: string,
): AppliedSqlMigration[] {
  const sql = resolveSql(storage);
  ensureMigrationTable(sql);
  return sql.exec<AppliedSqlMigration>(
    `SELECT component, id, name, checksum, applied_at
     FROM ${MIGRATIONS_TABLE}
     WHERE component = ?
     ORDER BY id`,
    component,
  ).toArray();
}

function ensureMigrationTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      component  TEXT    NOT NULL,
      id         INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (component, id)
    )
  `);
}

function applyMigration(
  storage: SqlMigrationStorage,
  sql: SqlStorage,
  component: string,
  migration: SqlMigration,
  checksum: string,
): void {
  runTransactionSync(storage, () => {
    for (const statement of migration.statements) {
      const trimmed = statement.trim();
      if (trimmed) {
        sql.exec(trimmed);
      }
    }
    sql.exec(
      `INSERT INTO ${MIGRATIONS_TABLE} (component, id, name, checksum, applied_at)
       VALUES (?, ?, ?, ?, ?)`,
      component,
      migration.id,
      migration.name,
      checksum,
      Date.now(),
    );
  });
}

function validateMigrations(migrations: readonly SqlMigration[]): void {
  let previousId = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.id) || migration.id <= 0) {
      throw new Error(`Invalid schema migration id: ${migration.id}`);
    }
    if (migration.id <= previousId) {
      throw new Error(`Schema migrations must be sorted by ascending id: ${migration.id}`);
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

function resolveSql(storage: SqlMigrationStorage): SqlStorage {
  return "sql" in storage ? storage.sql : storage;
}

function runTransactionSync(storage: SqlMigrationStorage, closure: () => void): void {
  if ("transactionSync" in storage) {
    storage.transactionSync(closure);
    return;
  }
  closure();
}
