const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PAGE_ROWS = 4;
const MAX_PAGE_ROWS = 16;

export type SqlExportBytes = {
  $bytes: string;
};

export type SqlExportValue = string | number | null | SqlExportBytes;

export type SqlExportTable = {
  name: string;
  createSql: string;
  restoreMode: "create" | "sqlite-sequence";
  columns: string[];
  rowCount: number;
  throughRowId: number | null;
};

export type SqlExportSchemaObject = {
  type: "index" | "trigger" | "view";
  name: string;
  tableName: string;
  createSql: string;
};

export type SqlExportCatalog = {
  format: "gsv-sql-snapshot";
  version: 1;
  tables: SqlExportTable[];
  schemaObjects: SqlExportSchemaObject[];
};

export type SqlExportPage = {
  table: string;
  columns: string[];
  rows: SqlExportValue[][];
  afterRowId: number | null;
  nextRowId: number | null;
  throughRowId: number | null;
  complete: boolean;
};

type SchemaRow = {
  name: string;
  sql: string;
};

type SchemaObjectRow = SchemaRow & {
  type: SqlExportSchemaObject["type"];
  table_name: string;
};

type TableStatsRow = {
  row_count: number;
  through_row_id: number | null;
};

type TableInfoRow = {
  name: string;
};

export function captureSqlExportCatalog(sql: SqlStorage): SqlExportCatalog {
  const schemaRows = sql.exec<SchemaRow>(
    `SELECT name, sql
     FROM sqlite_schema
     WHERE type = 'table' AND sql IS NOT NULL
     ORDER BY name`,
  ).toArray().filter((row) => isExportableTable(row.name, row.sql));

  const tables = schemaRows.map((row): SqlExportTable => {
    const identifier = quoteIdentifier(row.name);
    const stats = sql.exec<TableStatsRow>(
      `SELECT COUNT(*) AS row_count, MAX(rowid) AS through_row_id
       FROM ${identifier}`,
    ).one();
    const rowCount = safeInteger(stats.row_count, `${row.name} row count`);
    const throughRowId = stats.through_row_id === null
      ? null
      : safeInteger(stats.through_row_id, `${row.name} row ID`);
    const columns = sql.exec<TableInfoRow>(
      `PRAGMA table_info(${identifier})`,
    ).toArray().map((column) => column.name);
    if (columns.length === 0) {
      throw new Error(`export table ${row.name} has no columns`);
    }
    return {
      name: row.name,
      createSql: row.sql,
      restoreMode: row.name === "sqlite_sequence" ? "sqlite-sequence" : "create",
      columns,
      rowCount,
      throughRowId,
    };
  });

  const schemaObjects = sql.exec<SchemaObjectRow>(
    `SELECT type, name, tbl_name AS table_name, sql
     FROM sqlite_schema
     WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
     ORDER BY type, name`,
  ).toArray().filter((row) => (
    !row.name.startsWith("sqlite_") && !row.name.startsWith("_cf_")
  )).map((row): SqlExportSchemaObject => ({
    type: row.type,
    name: row.name,
    tableName: row.table_name,
    createSql: row.sql,
  }));

  return {
    format: "gsv-sql-snapshot",
    version: 1,
    tables,
    schemaObjects,
  };
}

export function readSqlExportPage(
  sql: SqlStorage,
  table: SqlExportTable,
  afterRowIdValue: number | null,
  limitValue = DEFAULT_PAGE_ROWS,
): SqlExportPage {
  assertExportTable(sql, table);
  const limit = pageLimit(limitValue);
  const afterRowId = afterRowIdValue === null
    ? null
    : safeInteger(afterRowIdValue, "export cursor");
  if (table.throughRowId === null) {
    return {
      table: table.name,
      columns: ["rowid", ...table.columns],
      rows: [],
      afterRowId,
      nextRowId: null,
      throughRowId: null,
      complete: true,
    };
  }

  const identifier = quoteIdentifier(table.name);
  const cursor = afterRowId === null
    ? sql.exec(
      `SELECT rowid AS __gsv_export_rowid__, *
       FROM ${identifier}
       WHERE rowid <= ?
       ORDER BY rowid
       LIMIT ?`,
      table.throughRowId,
      limit,
    )
    : sql.exec(
      `SELECT rowid AS __gsv_export_rowid__, *
       FROM ${identifier}
       WHERE rowid > ? AND rowid <= ?
       ORDER BY rowid
       LIMIT ?`,
      afterRowId,
      table.throughRowId,
      limit,
    );
  const rawRows = [...cursor.raw()] as unknown[][];
  const rows = rawRows.map((row) => row.map(encodeSqlExportValue));
  const nextRowId = rows.length === 0
    ? afterRowId
    : safeInteger(rows.at(-1)?.[0], `${table.name} export row ID`);
  return {
    table: table.name,
    columns: ["rowid", ...table.columns],
    rows,
    afterRowId,
    nextRowId,
    throughRowId: table.throughRowId,
    complete: rows.length === 0 || nextRowId === table.throughRowId,
  };
}

function assertExportTable(sql: SqlStorage, expected: SqlExportTable): void {
  const name = exportTableName(expected.name);
  const schema = sql.exec<SchemaRow>(
    `SELECT name, sql
     FROM sqlite_schema
     WHERE type = 'table' AND name = ? AND sql IS NOT NULL
     LIMIT 1`,
    name,
  ).toArray()[0];
  if (
    !schema
    || !isExportableTable(schema.name, schema.sql)
    || schema.sql !== expected.createSql
  ) {
    throw new Error(`export table ${name} changed during snapshot`);
  }
  const columns = sql.exec<TableInfoRow>(
    `PRAGMA table_info(${quoteIdentifier(name)})`,
  ).toArray().map((column) => column.name);
  if (
    columns.length !== expected.columns.length
    || columns.some((column, index) => column !== expected.columns[index])
  ) {
    throw new Error(`export table ${name} columns changed during snapshot`);
  }
}

function isExportableTable(name: string, createSql: string): boolean {
  if (name === "sqlite_sequence") return true;
  if (
    !TABLE_NAME_PATTERN.test(name)
    || name.startsWith("sqlite_")
    || name.startsWith("_cf_")
  ) {
    return false;
  }
  if (/\bWITHOUT\s+ROWID\b/i.test(createSql)) {
    throw new Error(`export table ${name} does not expose rowid pagination`);
  }
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(createSql)) {
    throw new Error(`export table ${name} is virtual`);
  }
  return true;
}

function exportTableName(value: string): string {
  if (
    !TABLE_NAME_PATTERN.test(value)
    || (value.startsWith("sqlite_") && value !== "sqlite_sequence")
  ) {
    throw new Error("export table name is invalid");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${exportTableName(value).replaceAll('"', '""')}"`;
}

function encodeSqlExportValue(value: unknown): SqlExportValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error("SQL export contains a non-portable number");
    }
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return { $bytes: base64Url(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $bytes: base64Url(new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      )),
    };
  }
  throw new Error("SQL export contains an unsupported value");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} is outside the portable integer range`);
  }
  return value;
}

function pageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ROWS) {
    throw new Error("SQL export page limit is invalid");
  }
  return value;
}
