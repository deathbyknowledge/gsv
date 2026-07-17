import type {
  ArchiveDataFrameInput,
  PortableKvDocumentV1,
  PortableSqliteValueV1,
  PortableStringV1,
} from "@humansandmachines/gsv-portable-archive";
import { DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "@humansandmachines/gsv-portable-archive";

export { DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "@humansandmachines/gsv-portable-archive";

export const DO_LOGICAL_SNAPSHOT_FORMAT = "gsv-do-logical-snapshot" as const;
export const DO_LOGICAL_SNAPSHOT_VERSION = 1 as const;
export const DO_LOGICAL_SNAPSHOT_REQUIRED_SCHEMA_FEATURES = Object.freeze([
  DO_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
] as const);

export const DO_DESCRIPTOR_MEDIA_TYPE =
  "application/vnd.gsv.do-descriptor.v1+json" as const;
export const DO_SQLITE_SCHEMA_MEDIA_TYPE =
  "application/vnd.gsv.do-sqlite-schema.v1+json" as const;
export const DO_SQLITE_ROWS_MEDIA_TYPE =
  "application/vnd.gsv.do-sqlite-rows.v1+json" as const;
export const DO_KV_MEDIA_TYPE = "application/vnd.gsv.do-kv.v1+json" as const;
export const DO_SQLITE_CELL_MEDIA_TYPE = "application/octet-stream" as const;

export const RESTORE_JOURNAL_PREFIX = "__gsv:restore:" as const;
export const MANAGED_KV_PREFIX = "__gsv:managed:" as const;

export type LogicalDoSqlValue = ArrayBuffer | string | number | null;

export type LogicalDoSqlCursor<T> = {
  toArray(): T[];
};

export type LogicalDoSql = {
  exec<T extends Record<string, LogicalDoSqlValue>>(
    query: string,
    ...bindings: LogicalDoSqlValue[]
  ): LogicalDoSqlCursor<T>;
};

export type LogicalDoSyncKv = {
  get<T = unknown>(key: string): T | undefined;
  list<T = unknown>(options?: Readonly<{
    start?: string;
    startAfter?: string;
    end?: string;
    prefix?: string;
    reverse?: boolean;
    limit?: number;
  }>): Iterable<[string, T]>;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

export type LogicalDoStorage = {
  sql: LogicalDoSql;
  kv: LogicalDoSyncKv;
  transactionSync<T>(closure: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type LogicalDoFence = Readonly<{
  assertFenced(): void;
}>;

/**
 * Exact inventory and semantic identity of one logical object frame stream.
 *
 * Restore journals bind this transcript before accepting frames. A restore ID
 * therefore cannot be reused with a different stream declaration, and a
 * restore is not finalizable until the complete transcript has been verified.
 */
export type LogicalDoRestoreTranscript = Readonly<{
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
}>;

export type DoDescriptorBodyV1 = Readonly<{
  format: typeof DO_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof DO_LOGICAL_SNAPSHOT_VERSION;
  record: "descriptor";
  objectId: string;
  sqlite: Readonly<{
    tableCount: string;
    rowCount: string;
  }>;
  kv: Readonly<{
    entryCount: string;
  }>;
  alarm: null | Readonly<{
    scheduledTime: string;
  }>;
}>;

export type DoSqliteColumnV1 = Readonly<{
  cid: number;
  name: string;
  declaredType: string;
  notNull: boolean;
  defaultSql: string | null;
  primaryKeyOrder: number;
  hidden: number;
}>;

export type DoSqliteTableV1 = Readonly<{
  name: string;
  createSql: string;
  withoutRowid: boolean;
  rowCount: string;
  columns: readonly DoSqliteColumnV1[];
  insertColumns: readonly string[];
  order: Readonly<
    | { kind: "rowid"; alias: "rowid" | "_rowid_" | "oid" }
    | { kind: "primary-key"; columns: readonly string[] }
  >;
}>;

export type DoSqliteIndexV1 = Readonly<{
  name: string;
  table: string;
  createSql: string;
}>;

export type DoSqliteSequenceV1 = Readonly<{
  table: string;
  value: string;
}>;

export type DoSqliteSchemaBodyV1 = Readonly<{
  format: typeof DO_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof DO_LOGICAL_SNAPSHOT_VERSION;
  record: "sqlite.schema";
  tables: readonly DoSqliteTableV1[];
  indexes: readonly DoSqliteIndexV1[];
  sequences: readonly DoSqliteSequenceV1[];
}>;

export type DoSqliteRowV1 = Readonly<{
  values: readonly PortableSqliteValueV1[];
}>;

export type DoSqliteRowsBodyV1 = Readonly<{
  format: typeof DO_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof DO_LOGICAL_SNAPSHOT_VERSION;
  record: "sqlite.rows";
  table: string;
  page: string;
  rows: readonly DoSqliteRowV1[];
}>;

export type DoKvEntryV1 = Readonly<{
  key: PortableStringV1;
  value: PortableKvDocumentV1;
}>;

export type DoKvBodyV1 = Readonly<{
  format: typeof DO_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof DO_LOGICAL_SNAPSHOT_VERSION;
  record: "do.kv";
  entries: readonly DoKvEntryV1[];
}>;

export type LogicalDoSnapshotFrame = ArchiveDataFrameInput;

export type LogicalDoSnapshotOptions = Readonly<{
  objectId: string;
  fence: LogicalDoFence;
  sqlQueryRows?: number;
  kvQueryEntries?: number;
  inlineCellBytes?: number;
  cellPartBytes?: number;
  jsonFrameBytes?: number;
  excludedSqlTables?: readonly string[];
  excludedKvPrefixes?: readonly string[];
}>;

export type LogicalDoRestoreOptions = Readonly<{
  restoreId: string;
  objectId: string;
  fence: LogicalDoFence;
  schemaMode?: "empty" | "fresh-migrated";
  preservedSqlTables?: readonly string[];
  preservedKvPrefixes?: readonly string[];
  transcript?: LogicalDoRestoreTranscript;
}>;
