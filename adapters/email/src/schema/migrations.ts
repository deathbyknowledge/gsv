import { MAIL_V001_INITIAL_SCHEMA } from "./v001_initial";
import { MAIL_V002_STAGED_INTAKE } from "./v002_staged_intake";
import { MAIL_V003_SUMMARY_GENERATION } from "./v003_summary_generation";
import { MAIL_V004_OUTBOUND_DELIVERY } from "./v004_outbound_delivery";

export type MailSqlMigration = {
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
const SCHEMA_COMPONENT = "managed_mail";

export const MAIL_MIGRATIONS: readonly MailSqlMigration[] = [
  MAIL_V001_INITIAL_SCHEMA,
  MAIL_V002_STAGED_INTAKE,
  MAIL_V003_SUMMARY_GENERATION,
  MAIL_V004_OUTBOUND_DELIVERY,
];

export function runMailSqlMigrations(storage: DurableObjectStorage): void {
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

  for (const migration of MAIL_MIGRATIONS) {
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
  for (const migration of MAIL_MIGRATIONS) {
    if (
      !Number.isSafeInteger(migration.id)
      || migration.id <= previousId
      || !migration.name.trim()
    ) {
      throw new Error(`Invalid managed mail schema migration: ${migration.id}`);
    }
    previousId = migration.id;
  }
}

function migrationChecksum(migration: MailSqlMigration): string {
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
