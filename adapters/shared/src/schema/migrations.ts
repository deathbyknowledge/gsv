import { ADAPTER_HIL_V001_STATE } from "./v001_adapter_hil";

type AdapterHilSqlMigration = {
  id: number;
  name: string;
  statements: readonly string[];
};

type AppliedMigration = {
  id: number;
  name: string;
  checksum: string;
};

const MIGRATIONS_TABLE = "_gsv_schema_migrations";
const SCHEMA_COMPONENT = "adapter_hil";

export const ADAPTER_HIL_MIGRATIONS: readonly AdapterHilSqlMigration[] = [
  ADAPTER_HIL_V001_STATE,
];

export function runAdapterHilSqlMigrations(storage: DurableObjectStorage): void {
  validateMigrations();
  const sql = storage.sql;
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
  const applied = new Map(sql.exec<AppliedMigration>(
    `SELECT id, name, checksum
     FROM ${MIGRATIONS_TABLE}
     WHERE component = ?
     ORDER BY id`,
    SCHEMA_COMPONENT,
  ).toArray().map((migration) => [migration.id, migration]));

  for (const migration of ADAPTER_HIL_MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    const existing = applied.get(migration.id);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(
          `Schema migration ${SCHEMA_COMPONENT}:${migration.id} changed after application`,
        );
      }
      continue;
    }
    storage.transactionSync(() => {
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(
        `INSERT INTO ${MIGRATIONS_TABLE}
           (component, id, name, checksum, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
        SCHEMA_COMPONENT,
        migration.id,
        migration.name,
        checksum,
        Date.now(),
      );
    });
  }
}

function validateMigrations(): void {
  let previousId = 0;
  for (const migration of ADAPTER_HIL_MIGRATIONS) {
    if (
      !Number.isSafeInteger(migration.id)
      || migration.id <= previousId
      || !migration.name.trim()
    ) {
      throw new Error(`Invalid adapter HIL schema migration: ${migration.id}`);
    }
    previousId = migration.id;
  }
}

function migrationChecksum(migration: AdapterHilSqlMigration): string {
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
