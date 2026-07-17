import type {
  DoSqliteColumnV1,
  DoSqliteIndexV1,
  DoSqliteSchemaBodyV1,
  DoSqliteSequenceV1,
  DoSqliteTableV1,
  LogicalDoSql,
  LogicalDoSqlValue,
} from "./portable-do-types";
import {
  DO_LOGICAL_SNAPSHOT_FORMAT,
  DO_LOGICAL_SNAPSHOT_VERSION,
} from "./portable-do-types";

const MAX_SQL_BYTES = 100_000;
const textEncoder = new TextEncoder();

export type NonPortableDoErrorCode =
  | "contentless_fts_not_portable"
  | "excluded_table_not_found"
  | "foreign_keys_not_portable"
  | "invalid_archive_record"
  | "invalid_sqlite_schema"
  | "nondeterministic_table_order"
  | "restore_conflict"
  | "restore_incomplete"
  | "restore_target_not_empty"
  | "schema_object_not_portable"
  | "virtual_table_not_portable";

export class NonPortableDoError extends Error {
  readonly code: NonPortableDoErrorCode;

  constructor(code: NonPortableDoErrorCode, message: string) {
    super(message);
    this.name = "NonPortableDoError";
    this.code = code;
  }
}

type SchemaRow = {
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
};

type ColumnRow = {
  cid: number;
  name: string;
  declaredType: string;
  notNull: number;
  defaultSql: string | null;
  primaryKeyOrder: number;
  hidden: number;
};

type TextValueRow = { value: string };

export function inspectPortableSqliteSchema(
  sql: LogicalDoSql,
  excludedTables: readonly string[] = [],
): DoSqliteSchemaBodyV1 {
  const excluded = validateExcludedSqlTables(excludedTables);
  const allSchemaRows = sql
    .exec<SchemaRow>(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       WHERE name = 'sqlite_sequence' OR name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .toArray();
  const platformTables = new Set(["__cf_kv", "_cf_KV", "_cf_METADATA"]);
  const userTableNames = new Set(
    allSchemaRows
      .filter((row) => row.type === "table" && !platformTables.has(row.name))
      .map((row) => row.name),
  );
  for (const name of excluded) {
    if (!userTableNames.has(name)) {
      throw new NonPortableDoError(
        "excluded_table_not_found",
        `Required excluded SQLite table ${JSON.stringify(name)} does not exist`,
      );
    }
  }
  const schemaRows = allSchemaRows.filter(
    (row) =>
      !platformTables.has(row.name) &&
      !platformTables.has(row.tableName) &&
      !excluded.has(row.name) &&
      !excluded.has(row.tableName),
  );

  rejectUnsupportedSchemaObjects(schemaRows);

  const tableRows = schemaRows.filter(
    (row) => row.type === "table" && row.name !== "sqlite_sequence",
  );
  rejectVirtualTables(tableRows);

  const tables = tableRows.map((row) => inspectTable(sql, row));
  const indexes = schemaRows
    .filter((row) => row.type === "index" && row.sql !== null)
    .map(inspectIndex);
  const sequences = inspectSequences(sql, schemaRows, excluded);

  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "sqlite.schema",
    tables,
    indexes,
    sequences,
  };
}

function rejectUnsupportedSchemaObjects(rows: readonly SchemaRow[]): void {
  for (const row of rows) {
    if (row.type === "table" || row.type === "index") continue;
    throw new NonPortableDoError(
      "schema_object_not_portable",
      `SQLite ${row.type} ${JSON.stringify(row.name)} is not portable in logical snapshot v1`,
    );
  }
}

function rejectVirtualTables(rows: readonly SchemaRow[]): void {
  for (const row of rows) {
    const createSql = requireCreateSql(row);
    if (!/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(createSql)) continue;
    const isFts = /\bUSING\s+FTS[345]\b/i.test(createSql);
    const isContentless = /\bcontent\s*=\s*(?:''|"")/i.test(createSql);
    if (isFts && isContentless) {
      throw new NonPortableDoError(
        "contentless_fts_not_portable",
        `Contentless FTS table ${JSON.stringify(row.name)} is not portable in logical snapshot v1`,
      );
    }
    throw new NonPortableDoError(
      "virtual_table_not_portable",
      `Virtual table ${JSON.stringify(row.name)} is not portable in logical snapshot v1`,
    );
  }
}

function inspectTable(sql: LogicalDoSql, row: SchemaRow): DoSqliteTableV1 {
  const createSql = requireCreateSql(row);
  assertSingleCreateStatement(createSql, "table");

  // Workerd authorizes table-valued schema introspection pragmas but denies
  // pragma_foreign_key_list. Every SQLite FK declaration necessarily contains
  // REFERENCES outside a quoted literal or identifier, so inspect the stored
  // CREATE statement instead.
  if (/\bREFERENCES\b|\bFOREIGN\s+KEY\b/i.test(stripSqlLiteralsAndIdentifiers(createSql))) {
    throw new NonPortableDoError(
      "foreign_keys_not_portable",
      `Table ${JSON.stringify(row.name)} uses foreign keys, which logical snapshot v1 cannot restore atomically across pages`,
    );
  }

  const columns = sql
    .exec<ColumnRow>(
      `SELECT cid,
              name,
              type AS declaredType,
              "notnull" AS "notNull",
              dflt_value AS "defaultSql",
              pk AS "primaryKeyOrder",
              hidden
       FROM pragma_table_xinfo(?)
       ORDER BY cid`,
      row.name,
    )
    .toArray()
    .map(normalizeColumn);
  if (columns.length === 0) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `Table ${JSON.stringify(row.name)} has no inspectable columns`,
    );
  }

  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(
    stripSqlLiteralsAndIdentifiers(createSql),
  );
  const order = determineTableOrder(row.name, withoutRowid, columns);
  const rowCount = singleText(
    sql.exec<TextValueRow>(
      `SELECT CAST(COUNT(*) AS TEXT) AS value FROM ${quoteIdentifier(row.name)}`,
    ).toArray(),
    `row count for ${row.name}`,
  );

  return {
    name: row.name,
    createSql,
    withoutRowid,
    rowCount,
    columns,
    insertColumns: columns.filter((column) => column.hidden === 0).map((column) => column.name),
    order,
  };
}

function normalizeColumn(row: ColumnRow): DoSqliteColumnV1 {
  for (const [label, value] of [
    ["cid", row.cid],
    ["notNull", row.notNull],
    ["primaryKeyOrder", row.primaryKeyOrder],
    ["hidden", row.hidden],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new NonPortableDoError(
        "invalid_sqlite_schema",
        `SQLite column ${label} is invalid`,
      );
    }
  }
  if (typeof row.name !== "string" || typeof row.declaredType !== "string") {
    throw new NonPortableDoError("invalid_sqlite_schema", "SQLite column metadata is invalid");
  }
  if (row.defaultSql !== null && typeof row.defaultSql !== "string") {
    throw new NonPortableDoError("invalid_sqlite_schema", "SQLite column default is invalid");
  }
  return {
    cid: row.cid,
    name: row.name,
    declaredType: row.declaredType,
    notNull: row.notNull !== 0,
    defaultSql: row.defaultSql,
    primaryKeyOrder: row.primaryKeyOrder,
    hidden: row.hidden,
  };
}

function determineTableOrder(
  tableName: string,
  withoutRowid: boolean,
  columns: readonly DoSqliteColumnV1[],
): DoSqliteTableV1["order"] {
  const primaryKey = columns
    .filter((column) => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
    .map((column) => column.name);
  if (withoutRowid) {
    if (primaryKey.length === 0) {
      throw new NonPortableDoError(
        "invalid_sqlite_schema",
        `WITHOUT ROWID table ${JSON.stringify(tableName)} has no primary key`,
      );
    }
    return { kind: "primary-key", columns: primaryKey };
  }

  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  for (const alias of ["_rowid_", "rowid", "oid"] as const) {
    if (!names.has(alias)) return { kind: "rowid", alias };
  }
  if (primaryKey.length > 0) return { kind: "primary-key", columns: primaryKey };
  throw new NonPortableDoError(
    "nondeterministic_table_order",
    `Table ${JSON.stringify(tableName)} shadows every rowid alias and has no primary key`,
  );
}

function inspectIndex(row: SchemaRow): DoSqliteIndexV1 {
  const createSql = requireCreateSql(row);
  assertSingleCreateStatement(createSql, "index");
  return { name: row.name, table: row.tableName, createSql };
}

function inspectSequences(
  sql: LogicalDoSql,
  rows: readonly SchemaRow[],
  excludedTables: ReadonlySet<string>,
): DoSqliteSequenceV1[] {
  if (!rows.some((row) => row.name === "sqlite_sequence")) return [];
  return sql
    .exec<{ tableName: string; value: string }>(
      `SELECT name AS tableName, CAST(seq AS TEXT) AS value
       FROM sqlite_sequence
       ORDER BY name`,
    )
    .toArray()
    .filter((row) => !excludedTables.has(row.tableName))
    .map((row) => {
      assertCanonicalInteger(row.value, "sqlite_sequence value");
      return { table: row.tableName, value: row.value };
    });
}

export function validateExcludedSqlTables(values: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      /[*?%]/.test(value)
    ) {
      throw new TypeError("Excluded SQLite table names must be exact non-wildcard identifiers");
    }
    if (value.startsWith("sqlite_") || value === "_cf_KV" || value === "_cf_METADATA") {
      throw new TypeError(`SQLite table ${JSON.stringify(value)} is platform-owned`);
    }
    if (result.has(value)) throw new TypeError(`Duplicate excluded SQLite table ${JSON.stringify(value)}`);
    result.add(value);
  }
  return result;
}

function requireCreateSql(row: SchemaRow): string {
  if (typeof row.sql !== "string" || row.sql.length === 0) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `SQLite ${row.type} ${JSON.stringify(row.name)} has no CREATE statement`,
    );
  }
  return row.sql;
}

export function assertSingleCreateStatement(
  sql: string,
  expected: "table" | "index",
): void {
  if (textEncoder.encode(sql).byteLength > MAX_SQL_BYTES || sql.includes("\0")) {
    throw new NonPortableDoError("invalid_sqlite_schema", "SQLite CREATE statement is invalid");
  }
  const visible = stripSqlLiteralsAndIdentifiers(sql);
  if (/--|\/\*/.test(visible)) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      "SQLite CREATE statements containing comments are not accepted",
    );
  }
  const semicolons = [...visible.matchAll(/;/g)].map((match) => match.index ?? -1);
  if (semicolons.length > 1 || (semicolons.length === 1 && visible.slice(semicolons[0] + 1).trim())) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      "SQLite schema record contains more than one statement",
    );
  }
  const prefix = expected === "table"
    ? /^\s*CREATE\s+TABLE\b/i
    : /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i;
  if (!prefix.test(visible)) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `SQLite schema record is not a CREATE ${expected.toUpperCase()} statement`,
    );
  }
}

function stripSqlLiteralsAndIdentifiers(sql: string): string {
  let result = "";
  let quote: "'" | "\"" | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote === null) {
      if (character === "'" || character === "\"" || character === "`") {
        quote = character;
        result += " ";
      } else if (character === "[") {
        quote = "]";
        result += " ";
      } else {
        result += character;
      }
      continue;
    }
    result += " ";
    if (character !== quote) continue;
    if (quote !== "]" && sql[index + 1] === quote) {
      result += " ";
      index += 1;
    } else {
      quote = null;
    }
  }
  if (quote !== null) {
    throw new NonPortableDoError("invalid_sqlite_schema", "SQLite CREATE statement is unterminated");
  }
  return result;
}

export function quoteIdentifier(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new NonPortableDoError("invalid_sqlite_schema", "SQLite identifier is invalid");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function assertCanonicalInteger(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(value) || value === "-0") {
    throw new NonPortableDoError("invalid_archive_record", `${label} is not a canonical integer`);
  }
}

export function sqlValueToBytes(value: LogicalDoSqlValue, label: string): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new NonPortableDoError("invalid_sqlite_schema", `${label} is not a SQLite byte value`);
}

function singleText(rows: readonly TextValueRow[], label: string): string {
  if (rows.length !== 1 || typeof rows[0]?.value !== "string") {
    throw new NonPortableDoError("invalid_sqlite_schema", `Could not read ${label}`);
  }
  assertCanonicalInteger(rows[0].value, label);
  return rows[0].value;
}
