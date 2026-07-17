import {
  canonicalJsonBytes,
  decodeSqliteTextUtf8,
  encodeKvValue,
  encodePortableString,
  sqliteBlob,
  sqliteBlobReference,
  sqliteInteger,
  sqliteNull,
  sqliteReal,
  sqliteTextFromUtf8,
  sqliteTextReference,
  type PortableSqliteValueV1,
} from "@humansandmachines/gsv-portable-archive";
import {
  inspectPortableSqliteSchema,
  NonPortableDoError,
  quoteIdentifier,
  sqlValueToBytes,
} from "./portable-do-schema";
import type {
  DoDescriptorBodyV1,
  DoKvBodyV1,
  DoKvEntryV1,
  DoSqliteRowV1,
  DoSqliteRowsBodyV1,
  DoSqliteTableV1,
  LogicalDoFence,
  LogicalDoSnapshotFrame,
  LogicalDoSnapshotOptions,
  LogicalDoSqlValue,
  LogicalDoStorage,
} from "./portable-do-types";
import { validatePortableDoIdentifier } from "./portable-do-identifiers";
import {
  DO_DESCRIPTOR_MEDIA_TYPE,
  DO_KV_MEDIA_TYPE,
  DO_LOGICAL_SNAPSHOT_FORMAT,
  DO_LOGICAL_SNAPSHOT_VERSION,
  DO_SQLITE_CELL_MEDIA_TYPE,
  DO_SQLITE_ROWS_MEDIA_TYPE,
  DO_SQLITE_SCHEMA_MEDIA_TYPE,
  MANAGED_KV_PREFIX,
  RESTORE_JOURNAL_PREFIX,
} from "./portable-do-types";

const DEFAULT_SQL_QUERY_ROWS = 16;
const DEFAULT_KV_QUERY_ENTRIES = 128;
const DEFAULT_INLINE_CELL_BYTES = 16 * 1024;
const DEFAULT_CELL_PART_BYTES = 1024 * 1024;
const DEFAULT_JSON_FRAME_BYTES = 1024 * 1024;
const MAX_JSON_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CELL_PART_BYTES = 1024 * 1024;
const MAX_PROJECTION_COLUMNS = 45;

type ResolvedSnapshotOptions = Readonly<{
  objectId: string;
  fence: LogicalDoFence;
  sqlQueryRows: number;
  kvQueryEntries: number;
  inlineCellBytes: number;
  cellPartBytes: number;
  jsonFrameBytes: number;
  excludedSqlTables: readonly string[];
  excludedKvPrefixes: readonly string[];
}>;

type ProjectionRow = Record<string, LogicalDoSqlValue>;

/**
 * Emits a deterministic logical snapshot. The caller must keep the object fenced
 * against all application reads and writes for the generator's entire lifetime.
 */
export async function* snapshotLogicalDurableObject(
  storage: LogicalDoStorage,
  options: LogicalDoSnapshotOptions,
): AsyncGenerator<LogicalDoSnapshotFrame> {
  const resolved = resolveSnapshotOptions(options);
  options.fence.assertFenced();

  const schema = inspectPortableSqliteSchema(storage.sql, resolved.excludedSqlTables);
  const kvEntryCount = countPortableKvEntries(storage, resolved);
  const alarm = await storage.getAlarm();
  options.fence.assertFenced();

  const descriptor: DoDescriptorBodyV1 = {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "descriptor",
    objectId: resolved.objectId,
    sqlite: {
      tableCount: schema.tables.length.toString(),
      rowCount: sumCanonicalCounts(schema.tables.map((table) => table.rowCount)),
    },
    kv: { entryCount: kvEntryCount.toString() },
    alarm: alarm === null ? null : { scheduledTime: alarmTimestamp(alarm) },
  };

  const descriptorFrame = jsonFrame(
    "do.descriptor",
    resolved.objectId,
    0,
    DO_DESCRIPTOR_MEDIA_TYPE,
    descriptor,
  );
  const schemaFrame = jsonFrame(
    "do.sqlite.schema",
    resolved.objectId,
    0,
    DO_SQLITE_SCHEMA_MEDIA_TYPE,
    schema,
  );
  yield descriptorFrame;
  yield schemaFrame;

  let rowPart = 0;
  let cellPart = 0;
  for (const table of schema.tables) {
    const parts = { row: rowPart, cell: cellPart };
    for (const frame of snapshotTable(storage, table, resolved, parts)) yield frame;
    rowPart = parts.row;
    cellPart = parts.cell;
  }

  let kvPart = 0;
  for (const body of snapshotKvBodies(storage, resolved)) {
    options.fence.assertFenced();
    yield jsonFrame("do.kv", resolved.objectId, kvPart, DO_KV_MEDIA_TYPE, body);
    kvPart += 1;
  }
  options.fence.assertFenced();
}

function* snapshotTable(
  storage: LogicalDoStorage,
  table: DoSqliteTableV1,
  options: ResolvedSnapshotOptions,
  parts: { row: number; cell: number },
): Generator<LogicalDoSnapshotFrame> {
  const totalRows = parseSafeCount(table.rowCount, `row count for ${table.name}`);
  let page = 0;
  let pendingRows: DoSqliteRowV1[] = [];

  for (let offset = 0; offset < totalRows; offset += options.sqlQueryRows) {
    options.fence.assertFenced();
    const rawRows = readProjectedRows(storage, table, options.sqlQueryRows, offset);
    for (const rawRow of rawRows) {
      const values: PortableSqliteValueV1[] = [];
      for (let column = 0; column < table.insertColumns.length; column += 1) {
        const encoded = encodeProjectedValue(
          rawRow[`t${column}`],
          rawRow[`v${column}`],
          options,
          parts.cell,
        );
        values.push(encoded.value);
        for (const body of encoded.cellBodies) {
          yield {
            kind: "do.sqlite.cell",
            objectId: options.objectId,
            part: parts.cell,
            bodyMediaType: DO_SQLITE_CELL_MEDIA_TYPE,
            body,
          };
          parts.cell += 1;
        }
      }
      const row = { values };
      const candidate = rowsBody(table.name, page, [...pendingRows, row]);
      if (
        pendingRows.length > 0 &&
        canonicalJsonBytes(candidate).byteLength > options.jsonFrameBytes
      ) {
        yield jsonFrame(
          "do.sqlite.rows",
          options.objectId,
          parts.row,
          DO_SQLITE_ROWS_MEDIA_TYPE,
          rowsBody(table.name, page, pendingRows),
        );
        parts.row += 1;
        page += 1;
        pendingRows = [row];
      } else {
        pendingRows.push(row);
      }
      assertBodySize(
        rowsBody(table.name, page, pendingRows),
        MAX_JSON_FRAME_BYTES,
        "SQLite row",
      );
    }
  }
  if (pendingRows.length > 0) {
    yield jsonFrame(
      "do.sqlite.rows",
      options.objectId,
      parts.row,
      DO_SQLITE_ROWS_MEDIA_TYPE,
      rowsBody(table.name, page, pendingRows),
    );
    parts.row += 1;
  }
}

function readProjectedRows(
  storage: LogicalDoStorage,
  table: DoSqliteTableV1,
  limit: number,
  offset: number,
): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  for (let start = 0; start < table.insertColumns.length; start += MAX_PROJECTION_COLUMNS) {
    const columns = table.insertColumns.slice(start, start + MAX_PROJECTION_COLUMNS);
    const projections = columns.flatMap((column, localIndex) => {
      const index = start + localIndex;
      const identifier = quoteIdentifier(column);
      return [
        `typeof(${identifier}) AS ${quoteIdentifier(`t${index}`)}`,
        `CASE typeof(${identifier})
           WHEN 'integer' THEN CAST(${identifier} AS TEXT)
           WHEN 'real' THEN ${identifier}
           WHEN 'text' THEN CAST(${identifier} AS BLOB)
           WHEN 'blob' THEN ${identifier}
           ELSE NULL
         END AS ${quoteIdentifier(`v${index}`)}`,
      ];
    });
    const order = table.order.kind === "rowid"
      ? quoteIdentifier(table.order.alias)
      : table.order.columns.map(quoteIdentifier).join(", ");
    const page = storage.sql
      .exec<ProjectionRow>(
        `SELECT ${projections.join(", ")}
         FROM ${quoteIdentifier(table.name)}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
        limit,
        offset,
      )
      .toArray();
    if (start === 0) {
      rows.push(...page);
    } else {
      if (page.length !== rows.length) {
        throw new NonPortableDoError(
          "invalid_sqlite_schema",
          `Table ${JSON.stringify(table.name)} changed while its fenced snapshot was read`,
        );
      }
      for (let index = 0; index < page.length; index += 1) Object.assign(rows[index], page[index]);
    }
  }
  if (table.insertColumns.length === 0) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `Table ${JSON.stringify(table.name)} has no stored columns`,
    );
  }
  return rows;
}

function encodeProjectedValue(
  type: LogicalDoSqlValue | undefined,
  value: LogicalDoSqlValue | undefined,
  options: ResolvedSnapshotOptions,
  firstCellPart: number,
): Readonly<{ value: PortableSqliteValueV1; cellBodies: readonly Uint8Array[] }> {
  if (type === "null") return { value: sqliteNull(), cellBodies: [] };
  if (type === "integer") {
    if (typeof value !== "string") return invalidProjection("integer");
    return { value: sqliteInteger(BigInt(value)), cellBodies: [] };
  }
  if (type === "real") {
    if (typeof value !== "number") return invalidProjection("real");
    return { value: sqliteReal(value), cellBodies: [] };
  }
  if (type !== "text" && type !== "blob") return invalidProjection("storage class");
  const bytes = sqlValueToBytes(value ?? null, `SQLite ${type}`);
  if (type === "text") decodeSqliteTextUtf8(bytes);
  if (bytes.byteLength <= options.inlineCellBytes) {
    return {
      value: type === "text" ? sqliteTextFromUtf8(bytes) : sqliteBlob(bytes),
      cellBodies: [],
    };
  }

  const cellBodies: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += options.cellPartBytes) {
    cellBodies.push(bytes.slice(offset, offset + options.cellPartBytes));
  }
  if (firstCellPart + cellBodies.length - 1 > 0xffff_ffff) {
    throw new RangeError("Logical snapshot SQLite cell parts exceed the unsigned 32-bit range");
  }
  const reference = {
    byteLength: BigInt(bytes.byteLength),
    objectId: options.objectId,
    firstPart: firstCellPart,
    partCount: cellBodies.length,
  };
  return {
    value: type === "text" ? sqliteTextReference(reference) : sqliteBlobReference(reference),
    cellBodies,
  };
}

function invalidProjection(label: string): never {
  throw new NonPortableDoError(
    "invalid_sqlite_schema",
    `SQLite returned an invalid ${label} projection`,
  );
}

function rowsBody(table: string, page: number, rows: readonly DoSqliteRowV1[]): DoSqliteRowsBodyV1 {
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "sqlite.rows",
    table,
    page: page.toString(),
    rows,
  };
}

function* snapshotKvBodies(
  storage: LogicalDoStorage,
  options: ResolvedSnapshotOptions,
): Generator<DoKvBodyV1> {
  let startAfter: string | undefined;
  let entries: DoKvEntryV1[] = [];
  while (true) {
    const page = [...storage.kv.list({ startAfter, limit: options.kvQueryEntries })];
    if (page.length === 0) break;
    for (const [key, value] of page) {
      startAfter = key;
      if (isExcludedKvKey(key, options.excludedKvPrefixes)) continue;
      const entry: DoKvEntryV1 = {
        key: encodePortableString(key),
        value: encodeKvValue(value),
      };
      const candidate = kvBody([...entries, entry]);
      if (entries.length > 0 && canonicalJsonBytes(candidate).byteLength > options.jsonFrameBytes) {
        yield kvBody(entries);
        entries = [entry];
      } else {
        entries.push(entry);
      }
      assertBodySize(kvBody(entries), MAX_JSON_FRAME_BYTES, "DO KV entry");
    }
    if (page.length < options.kvQueryEntries) break;
  }
  if (entries.length > 0) yield kvBody(entries);
}

function kvBody(entries: readonly DoKvEntryV1[]): DoKvBodyV1 {
  return {
    format: DO_LOGICAL_SNAPSHOT_FORMAT,
    version: DO_LOGICAL_SNAPSHOT_VERSION,
    record: "do.kv",
    entries,
  };
}

function countPortableKvEntries(
  storage: LogicalDoStorage,
  options: ResolvedSnapshotOptions,
): bigint {
  let count = 0n;
  let startAfter: string | undefined;
  while (true) {
    const page = [...storage.kv.list({ startAfter, limit: options.kvQueryEntries })];
    if (page.length === 0) break;
    for (const [key, value] of page) {
      startAfter = key;
      if (!isExcludedKvKey(key, options.excludedKvPrefixes)) {
        const entry: DoKvEntryV1 = {
          key: encodePortableString(key),
          value: encodeKvValue(value),
        };
        assertBodySize(kvBody([entry]), MAX_JSON_FRAME_BYTES, "DO KV entry");
        count += 1n;
      }
    }
    if (page.length < options.kvQueryEntries) break;
  }
  return count;
}

function isExcludedKvKey(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function jsonFrame(
  kind: LogicalDoSnapshotFrame["kind"],
  objectId: string,
  part: number,
  bodyMediaType: string,
  value: unknown,
): LogicalDoSnapshotFrame {
  if (!Number.isSafeInteger(part) || part < 0 || part > 0xffff_ffff) {
    throw new RangeError(`Logical snapshot ${kind} part is outside the unsigned 32-bit range`);
  }
  const body = canonicalJsonBytes(value);
  if (body.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `Logical snapshot ${kind} record exceeds the portable archive frame limit`,
    );
  }
  return { kind, objectId, part, bodyMediaType, body };
}

function resolveSnapshotOptions(options: LogicalDoSnapshotOptions): ResolvedSnapshotOptions {
  validatePortableDoIdentifier(options.objectId, "snapshot objectId");
  const excludedKvPrefixes = [
    RESTORE_JOURNAL_PREFIX,
    MANAGED_KV_PREFIX,
    ...(options.excludedKvPrefixes ?? []),
  ];
  if (excludedKvPrefixes.some((prefix) => typeof prefix !== "string" || prefix.length === 0)) {
    throw new TypeError("Logical snapshot excluded KV prefixes must be non-empty strings");
  }
  return {
    objectId: options.objectId,
    fence: options.fence,
    sqlQueryRows: positiveInteger(options.sqlQueryRows, DEFAULT_SQL_QUERY_ROWS, "sqlQueryRows"),
    kvQueryEntries: positiveInteger(
      options.kvQueryEntries,
      DEFAULT_KV_QUERY_ENTRIES,
      "kvQueryEntries",
    ),
    inlineCellBytes: nonNegativeInteger(
      options.inlineCellBytes,
      DEFAULT_INLINE_CELL_BYTES,
      "inlineCellBytes",
    ),
    cellPartBytes: boundedPositiveInteger(
      options.cellPartBytes,
      DEFAULT_CELL_PART_BYTES,
      MAX_CELL_PART_BYTES,
      "cellPartBytes",
    ),
    jsonFrameBytes: boundedPositiveInteger(
      options.jsonFrameBytes,
      DEFAULT_JSON_FRAME_BYTES,
      MAX_JSON_FRAME_BYTES,
      "jsonFrameBytes",
    ),
    excludedSqlTables: [...(options.excludedSqlTables ?? [])],
    excludedKvPrefixes: [...new Set(excludedKvPrefixes)],
  };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  return boundedPositiveInteger(value, fallback, Number.MAX_SAFE_INTEGER, label);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new RangeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return result;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return result;
}

function parseSafeCount(value: string, label: string): number {
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `${label} exceeds the deterministic v1 paging limit`,
    );
  }
  return Number(count);
}

function sumCanonicalCounts(values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

function alarmTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NonPortableDoError("invalid_sqlite_schema", "Durable Object alarm is invalid");
  }
  return value.toString();
}

function assertBodySize(value: unknown, maximum: number, label: string): void {
  if (canonicalJsonBytes(value).byteLength > maximum) {
    throw new NonPortableDoError(
      "invalid_sqlite_schema",
      `${label} cannot fit in a logical snapshot frame`,
    );
  }
}
