import { sqlMigrationChecksum } from "../../schema/runner";
import {
  APP_RUNNER_MIGRATIONS,
  APP_RUNNER_SCHEMA_COMPONENT,
  runAppRunnerSqlMigrations,
} from "./migrations";

type SchemaObjectRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

type TableColumnRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexListRow = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
};

type IndexColumnRow = {
  seqno: number;
  cid: number;
  name: string;
};

type MigrationLedgerRow = {
  component: string;
  id: number;
  name: string;
  checksum: string;
  applied_at: number;
};

type ExpectedColumn = Omit<TableColumnRow, "cid">;

const MIGRATIONS_TABLE = "_gsv_schema_migrations";
const SCHEDULES_TABLE = "app_rpc_schedules";
const DUE_INDEX = "idx_app_rpc_schedules_due";
const AUTHORITY_INDEX = "idx_app_rpc_schedules_authority";

const EXPECTED_SCHEMA_OBJECTS = new Map<string, { type: string; table: string }>([
  [MIGRATIONS_TABLE, { type: "table", table: MIGRATIONS_TABLE }],
  [SCHEDULES_TABLE, { type: "table", table: SCHEDULES_TABLE }],
  [DUE_INDEX, { type: "index", table: SCHEDULES_TABLE }],
  [AUTHORITY_INDEX, { type: "index", table: SCHEDULES_TABLE }],
]);

const EXPECTED_MIGRATION_COLUMNS: readonly ExpectedColumn[] = [
  column("component", "TEXT", 1, null, 1),
  column("id", "INTEGER", 1, null, 2),
  column("name", "TEXT", 1, null, 0),
  column("checksum", "TEXT", 1, null, 0),
  column("applied_at", "INTEGER", 1, null, 0),
];

const EXPECTED_SCHEDULE_COLUMNS: readonly ExpectedColumn[] = [
  column("schedule_key", "TEXT", 0, null, 1),
  column("rpc_method", "TEXT", 1, null, 0),
  column("schedule_json", "TEXT", 1, null, 0),
  column("payload_json", "TEXT", 0, null, 0),
  column("enabled", "INTEGER", 1, "1", 0),
  column("version", "INTEGER", 1, "1", 0),
  column("created_at", "INTEGER", 1, null, 0),
  column("updated_at", "INTEGER", 1, null, 0),
  column("next_run_at", "INTEGER", 0, null, 0),
  column("running_at", "INTEGER", 0, null, 0),
  column("last_run_at", "INTEGER", 0, null, 0),
  column("last_status", "TEXT", 0, null, 0),
  column("last_error", "TEXT", 0, null, 0),
  column("last_duration_ms", "INTEGER", 0, null, 0),
  column("logical_key", "TEXT", 0, null, 0),
  column("authority_key", "TEXT", 0, null, 0),
  column("owner_uid", "INTEGER", 0, null, 0),
  column("owner_username", "TEXT", 0, null, 0),
  column("kernel_username", "TEXT", 0, null, 0),
  column("kernel_generation", "INTEGER", 0, null, 0),
  column("package_id", "TEXT", 0, null, 0),
  column("package_name", "TEXT", 0, null, 0),
  column("package_updated_at", "INTEGER", 0, null, 0),
  column("artifact_hash", "TEXT", 0, null, 0),
  column("entrypoint_name", "TEXT", 0, null, 0),
  column("route_base", "TEXT", 0, null, 0),
  column("runtime_authority_json", "TEXT", 0, null, 0),
];

const EXPECTED_INDEX_COLUMNS = new Map<string, readonly string[]>([
  [DUE_INDEX, ["enabled", "next_run_at", "schedule_key"]],
  [AUTHORITY_INDEX, ["authority_key", "logical_key"]],
]);

function column(
  name: string,
  type: string,
  notnull: number,
  dflt_value: string | null,
  pk: number,
): ExpectedColumn {
  return { name, type, notnull, dflt_value, pk };
}

/**
 * Initializes only a fresh or structurally recognized v2 control database.
 * Unknown user schema objects fail closed before the migration runner can
 * mutate them. The caller must retain the false result as a runtime gate.
 */
export function initializeAppRunnerControlSchema(storage: DurableObjectStorage): boolean {
  try {
    if (hasUnexpectedSchemaObjects(storage.sql)) {
      return false;
    }
    runAppRunnerSqlMigrations(storage);
    return appRunnerControlSchemaIsCurrent(storage.sql);
  } catch {
    return false;
  }
}

/**
 * This check is deliberately independent of the migration runner's ledger.
 * It verifies both the physical v2 control schema and the exact ledger rows.
 */
export function appRunnerControlSchemaIsCurrent(sql: SqlStorage): boolean {
  try {
    const objects = userSchemaObjects(sql);
    if (objects.length !== EXPECTED_SCHEMA_OBJECTS.size) {
      return false;
    }
    for (const object of objects) {
      const expected = EXPECTED_SCHEMA_OBJECTS.get(object.name);
      if (!expected || object.type !== expected.type || object.tbl_name !== expected.table) {
        return false;
      }
    }
    if (!columnsMatch(sql, MIGRATIONS_TABLE, EXPECTED_MIGRATION_COLUMNS)) {
      return false;
    }
    if (!columnsMatch(sql, SCHEDULES_TABLE, EXPECTED_SCHEDULE_COLUMNS)) {
      return false;
    }

    const scheduleObject = objects.find((object) => object.name === SCHEDULES_TABLE);
    const normalizedScheduleSql = normalizeSql(scheduleObject?.sql ?? "");
    if (!normalizedScheduleSql.includes(
      "check (kernel_generation is null or kernel_generation > 0)",
    )) {
      return false;
    }

    const indexes = sql.exec<IndexListRow>(
      `PRAGMA index_list(${SCHEDULES_TABLE})`,
    ).toArray();
    const explicitIndexes = indexes.filter((index) => index.origin === "c");
    if (explicitIndexes.length !== EXPECTED_INDEX_COLUMNS.size) {
      return false;
    }
    for (const index of explicitIndexes) {
      const expectedColumns = EXPECTED_INDEX_COLUMNS.get(index.name);
      if (!expectedColumns || index.unique !== 0 || index.partial !== 0) {
        return false;
      }
      const actualColumns = sql.exec<IndexColumnRow>(
        `PRAGMA index_info(${index.name})`,
      ).toArray().sort((left, right) => left.seqno - right.seqno);
      if (
        actualColumns.length !== expectedColumns.length
        || actualColumns.some((actual, offset) => actual.name !== expectedColumns[offset])
      ) {
        return false;
      }
    }

    const ledger = sql.exec<MigrationLedgerRow>(
      `SELECT component, id, name, checksum, applied_at
       FROM ${MIGRATIONS_TABLE}
       ORDER BY component, id`,
    ).toArray();
    if (ledger.length !== APP_RUNNER_MIGRATIONS.length) {
      return false;
    }
    return APP_RUNNER_MIGRATIONS.every((migration, offset) => {
      const row = ledger[offset];
      return row?.component === APP_RUNNER_SCHEMA_COMPONENT
        && row.id === migration.id
        && row.name === migration.name
        && row.checksum === sqlMigrationChecksum(migration)
        && Number.isSafeInteger(row.applied_at)
        && row.applied_at > 0;
    });
  } catch {
    return false;
  }
}

function hasUnexpectedSchemaObjects(sql: SqlStorage): boolean {
  return userSchemaObjects(sql).some((object) => {
    const expected = EXPECTED_SCHEMA_OBJECTS.get(object.name);
    return !expected || object.type !== expected.type || object.tbl_name !== expected.table;
  });
}

function userSchemaObjects(sql: SqlStorage): SchemaObjectRow[] {
  return sql.exec<SchemaObjectRow>(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
       AND name != '__cf_kv'
     ORDER BY type, name`,
  ).toArray();
}

function columnsMatch(
  sql: SqlStorage,
  table: string,
  expected: readonly ExpectedColumn[],
): boolean {
  const actual = sql.exec<TableColumnRow>(`PRAGMA table_info(${table})`)
    .toArray()
    .sort((left, right) => left.cid - right.cid);
  return actual.length === expected.length && actual.every((value, offset) => {
    const target = expected[offset];
    return value.name === target?.name
      && value.type.toUpperCase() === target.type
      && value.notnull === target.notnull
      && value.dflt_value === target.dflt_value
      && value.pk === target.pk;
  });
}

function normalizeSql(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
