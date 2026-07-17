import {
  decodeKvValue,
  decodePortableString,
  decodeSqliteValue,
  type CanonicalJsonValue,
} from "@humansandmachines/gsv-portable-archive";
import {
  assertCanonicalInteger,
  assertSingleCreateStatement,
  NonPortableDoError,
} from "./portable-do-schema";
import type {
  DoDescriptorBodyV1,
  DoKvBodyV1,
  DoKvEntryV1,
  DoSqliteColumnV1,
  DoSqliteIndexV1,
  DoSqliteRowV1,
  DoSqliteRowsBodyV1,
  DoSqliteSchemaBodyV1,
  DoSqliteSequenceV1,
  DoSqliteTableV1,
} from "./portable-do-types";
import {
  DO_LOGICAL_SNAPSHOT_FORMAT,
  DO_LOGICAL_SNAPSHOT_VERSION,
  MANAGED_KV_PREFIX,
  RESTORE_JOURNAL_PREFIX,
} from "./portable-do-types";

export function decodeDescriptorRecord(
  input: CanonicalJsonValue,
  objectId: string,
): DoDescriptorBodyV1 {
  const record = exactRecord(input, [
    "format",
    "version",
    "record",
    "objectId",
    "sqlite",
    "kv",
    "alarm",
  ], "DO descriptor");
  assertRecordHeader(record, "descriptor");
  if (record.objectId !== objectId) invalid("DO descriptor objectId does not match its frame");
  const sqlite = exactRecord(record.sqlite, ["tableCount", "rowCount"], "DO SQLite descriptor");
  const kv = exactRecord(record.kv, ["entryCount"], "DO KV descriptor");
  const tableCount = unsignedString(sqlite.tableCount, "DO table count");
  const rowCount = unsignedString(sqlite.rowCount, "DO row count");
  const entryCount = unsignedString(kv.entryCount, "DO KV entry count");
  let alarm: DoDescriptorBodyV1["alarm"] = null;
  if (record.alarm !== null) {
    const alarmRecord = exactRecord(record.alarm, ["scheduledTime"], "DO alarm descriptor");
    alarm = {
      scheduledTime: unsignedString(alarmRecord.scheduledTime, "DO alarm timestamp"),
    };
  }
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "descriptor",
    objectId,
    sqlite: { tableCount, rowCount },
    kv: { entryCount },
    alarm,
  };
}

export function decodeSchemaRecord(input: CanonicalJsonValue): DoSqliteSchemaBodyV1 {
  const record = exactRecord(
    input,
    ["format", "version", "record", "tables", "indexes", "sequences"],
    "DO SQLite schema",
  );
  assertRecordHeader(record, "sqlite.schema");
  const tables = expectArray(record.tables, "DO SQLite tables").map(decodeTable);
  const indexes = expectArray(record.indexes, "DO SQLite indexes").map(decodeIndex);
  const sequences = expectArray(record.sequences, "DO SQLite sequences").map(decodeSequence);
  assertUnique(tables.map((table) => table.name), "table");
  assertUnique(indexes.map((index) => index.name), "index");
  const tableNames = new Set(tables.map((table) => table.name));
  for (const index of indexes) {
    if (!tableNames.has(index.table)) invalid(`Index ${JSON.stringify(index.name)} has no table`);
  }
  for (const sequence of sequences) {
    if (!tableNames.has(sequence.table)) {
      invalid(`sqlite_sequence entry ${JSON.stringify(sequence.table)} has no table`);
    }
  }
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "sqlite.schema",
    tables,
    indexes,
    sequences,
  };
}

export function decodeRowsRecord(input: CanonicalJsonValue): DoSqliteRowsBodyV1 {
  const record = exactRecord(
    input,
    ["format", "version", "record", "table", "page", "rows"],
    "DO SQLite rows",
  );
  assertRecordHeader(record, "sqlite.rows");
  const table = nonEmptyString(record.table, "SQLite row table");
  const page = unsignedString(record.page, "SQLite row page");
  const rows: DoSqliteRowV1[] = expectArray(record.rows, "SQLite rows").map((value) => {
    const row = exactRecord(value, ["values"], "SQLite row");
    const values = expectArray(row.values, "SQLite row values").map((cell) => {
      // The codec performs exact-key, range, byte-length, and canonical-value checks.
      decodeSqliteValue(cell as never);
      return cell as DoSqliteRowV1["values"][number];
    });
    return { values };
  });
  if (rows.length === 0) invalid("SQLite row frames must not be empty");
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "sqlite.rows",
    table,
    page,
    rows,
  };
}

export function decodeKvRecord(input: CanonicalJsonValue): DoKvBodyV1 {
  const record = exactRecord(
    input,
    ["format", "version", "record", "entries"],
    "DO KV record",
  );
  assertRecordHeader(record, "do.kv");
  const entries: DoKvEntryV1[] = expectArray(record.entries, "DO KV entries").map((value) => {
    const entry = exactRecord(value, ["key", "value"], "DO KV entry");
    const key = decodePortableString(entry.key as never);
    if (key.startsWith(RESTORE_JOURNAL_PREFIX) || key.startsWith(MANAGED_KV_PREFIX)) {
      invalid(`DO KV key ${JSON.stringify(key)} uses a reserved prefix`);
    }
    decodeKvValue(entry.value as never);
    return {
      key: entry.key as DoKvEntryV1["key"],
      value: entry.value as DoKvEntryV1["value"],
    };
  });
  if (entries.length === 0) invalid("DO KV frames must not be empty");
  const decodedKeys = entries.map((entry) => decodePortableString(entry.key));
  assertUnique(decodedKeys, "DO KV key");
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "do.kv",
    entries,
  };
}

function decodeTable(value: CanonicalJsonValue): DoSqliteTableV1 {
  const record = exactRecord(
    value,
    ["name", "createSql", "withoutRowid", "rowCount", "columns", "insertColumns", "order"],
    "SQLite table",
  );
  const name = nonEmptyString(record.name, "SQLite table name");
  if (
    name.startsWith("sqlite_") ||
    name === "__cf_kv" ||
    name === "_cf_KV" ||
    name === "_cf_METADATA"
  ) {
    invalid(`SQLite table ${JSON.stringify(name)} is platform-owned`);
  }
  const createSql = nonEmptyString(record.createSql, "SQLite table CREATE statement");
  assertSingleCreateStatement(createSql, "table");
  const withoutRowid = expectBoolean(record.withoutRowid, "SQLite WITHOUT ROWID flag");
  const rowCount = unsignedString(record.rowCount, "SQLite table row count");
  const columns = expectArray(record.columns, "SQLite columns").map(decodeColumn);
  if (columns.length === 0 || columns.length > 100) invalid("SQLite table column count is invalid");
  assertUnique(columns.map((column) => column.name), "column");
  for (let cid = 0; cid < columns.length; cid += 1) {
    if (columns[cid]?.cid !== cid) invalid("SQLite column ids must be contiguous and ordered");
  }
  const insertColumns = expectArray(record.insertColumns, "SQLite insert columns").map((column) =>
    nonEmptyString(column, "SQLite insert column"),
  );
  const expectedInsertColumns = columns
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
  if (!sameStrings(insertColumns, expectedInsertColumns)) {
    invalid(`SQLite table ${JSON.stringify(name)} insert columns do not match stored columns`);
  }
  const orderRecord = exactRecordVariant(record.order, "kind", "SQLite table order");
  let order: DoSqliteTableV1["order"];
  if (orderRecord.kind === "rowid") {
    exactKeys(orderRecord, ["kind", "alias"], "SQLite rowid order");
    if (!["rowid", "_rowid_", "oid"].includes(String(orderRecord.alias))) {
      invalid("SQLite rowid alias is invalid");
    }
    if (withoutRowid) invalid("WITHOUT ROWID table cannot use rowid ordering");
    order = { kind: "rowid", alias: orderRecord.alias as "rowid" | "_rowid_" | "oid" };
  } else if (orderRecord.kind === "primary-key") {
    exactKeys(orderRecord, ["kind", "columns"], "SQLite primary-key order");
    const orderColumns = expectArray(orderRecord.columns, "SQLite primary-key columns").map((column) =>
      nonEmptyString(column, "SQLite primary-key column"),
    );
    const expected = columns
      .filter((column) => column.primaryKeyOrder > 0)
      .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
      .map((column) => column.name);
    if (orderColumns.length === 0 || !sameStrings(orderColumns, expected)) {
      invalid("SQLite primary-key order does not match column metadata");
    }
    order = { kind: "primary-key", columns: orderColumns };
  } else {
    invalid("SQLite table order kind is invalid");
  }
  return { name, createSql, withoutRowid, rowCount, columns, insertColumns, order };
}

function decodeColumn(value: CanonicalJsonValue): DoSqliteColumnV1 {
  const record = exactRecord(
    value,
    ["cid", "name", "declaredType", "notNull", "defaultSql", "primaryKeyOrder", "hidden"],
    "SQLite column",
  );
  const defaultSql = record.defaultSql === null
    ? null
    : expectString(record.defaultSql, "SQLite column default");
  return {
    cid: u32(record.cid, "SQLite column id"),
    name: nonEmptyString(record.name, "SQLite column name"),
    declaredType: expectString(record.declaredType, "SQLite declared type"),
    notNull: expectBoolean(record.notNull, "SQLite not-null flag"),
    defaultSql,
    primaryKeyOrder: u32(record.primaryKeyOrder, "SQLite primary-key order"),
    hidden: u32(record.hidden, "SQLite hidden flag"),
  };
}

function decodeIndex(value: CanonicalJsonValue): DoSqliteIndexV1 {
  const record = exactRecord(value, ["name", "table", "createSql"], "SQLite index");
  const createSql = nonEmptyString(record.createSql, "SQLite index CREATE statement");
  assertSingleCreateStatement(createSql, "index");
  return {
    name: nonEmptyString(record.name, "SQLite index name"),
    table: nonEmptyString(record.table, "SQLite index table"),
    createSql,
  };
}

function decodeSequence(value: CanonicalJsonValue): DoSqliteSequenceV1 {
  const record = exactRecord(value, ["table", "value"], "sqlite_sequence entry");
  const integer = signedString(record.value, "sqlite_sequence value");
  assertI64(integer, "sqlite_sequence value");
  return {
    table: nonEmptyString(record.table, "sqlite_sequence table"),
    value: integer,
  };
}

function assertRecordHeader(record: Record<string, CanonicalJsonValue>, type: string): void {
  if (
    record.format !== DO_LOGICAL_SNAPSHOT_FORMAT ||
    record.version !== DO_LOGICAL_SNAPSHOT_VERSION ||
    record.record !== type
  ) {
    invalid(`Invalid ${type} record header`);
  }
}

function exactRecord(
  value: CanonicalJsonValue,
  keys: readonly string[],
  label: string,
): Record<string, CanonicalJsonValue> {
  const record = expectRecord(value, label);
  exactKeys(record, keys, label);
  return record;
}

function exactRecordVariant(
  value: CanonicalJsonValue,
  discriminator: string,
  label: string,
): Record<string, CanonicalJsonValue> {
  const record = expectRecord(value, label);
  if (!(discriminator in record)) invalid(`${label} is missing ${discriminator}`);
  return record;
}

function expectRecord(value: CanonicalJsonValue, label: string): Record<string, CanonicalJsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, CanonicalJsonValue>;
}

function exactKeys(
  record: Record<string, CanonicalJsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  if (!sameStrings(actual, sorted)) invalid(`${label} has unknown or missing fields`);
}

function expectArray(value: CanonicalJsonValue, label: string): CanonicalJsonValue[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function expectString(value: CanonicalJsonValue, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: CanonicalJsonValue, label: string): string {
  const result = expectString(value, label);
  if (result.length === 0 || result.includes("\0")) invalid(`${label} is invalid`);
  return result;
}

function expectBoolean(value: CanonicalJsonValue, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
  return value;
}

function u32(value: CanonicalJsonValue, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > 0xffff_ffff) {
    invalid(`${label} is outside the unsigned 32-bit range`);
  }
  return value;
}

function unsignedString(value: CanonicalJsonValue, label: string): string {
  const result = signedString(value, label);
  if (result.startsWith("-")) invalid(`${label} must be non-negative`);
  return result;
}

function signedString(value: CanonicalJsonValue, label: string): string {
  assertCanonicalInteger(value, label);
  return value;
}

function assertI64(value: string, label: string): void {
  const integer = BigInt(value);
  if (integer < -9_223_372_036_854_775_808n || integer > 9_223_372_036_854_775_807n) {
    invalid(`${label} is outside the SQLite signed 64-bit range`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`Duplicate ${label} ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalid(message: string): never {
  throw new NonPortableDoError("invalid_archive_record", message);
}
