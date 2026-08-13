import { INFERENCE_V001_INITIAL_SCHEMA } from "./v001_initial";
import { INFERENCE_V002_MAIL_INTAKE } from "./v002_mail_intake";

export type InferenceSqlMigration = {
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
const SCHEMA_COMPONENT = "managed_inference";

export const INFERENCE_MIGRATIONS: readonly InferenceSqlMigration[] = [
  INFERENCE_V001_INITIAL_SCHEMA,
  INFERENCE_V002_MAIL_INTAKE,
];

export function runInferenceSqlMigrations(
  storage: DurableObjectStorage,
): void {
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

  for (const migration of INFERENCE_MIGRATIONS) {
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
      for (const statement of migration.statements) {
        const sqlStatement = statement.trim();
        if (sqlStatement) sql.exec(sqlStatement);
      }
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
  for (const migration of INFERENCE_MIGRATIONS) {
    if (
      !Number.isSafeInteger(migration.id)
      || migration.id <= previousId
      || !migration.name.trim()
    ) {
      throw new Error(`Invalid managed inference schema migration: ${migration.id}`);
    }
    previousId = migration.id;
  }
}

function migrationChecksum(migration: InferenceSqlMigration): string {
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
