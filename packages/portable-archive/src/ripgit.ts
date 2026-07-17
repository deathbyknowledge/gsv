import { canonicalJsonBytes, parseCanonicalJson } from "./canonical-json";
import { MAX_FRAME_BODY_BYTES } from "./constants";
import { type PortableCrypto, sha256 } from "./crypto";
import { fail } from "./error";
import { RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";
import type { ArchiveDataFrameInput } from "./inner";
import type {
  ArchiveSqliteInventoryV1,
  ArchiveSqliteTableV1,
} from "./manifest";

export { RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";

/** Exact logical snapshot contract emitted by the public ripgit worker. */
export const RIPGIT_SNAPSHOT_FORMAT = "gsv-ripgit-logical-sql-v1" as const;
export const RIPGIT_SNAPSHOT_REQUIRED_SCHEMA_FEATURES = Object.freeze([
  RIPGIT_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
] as const);
export const RIPGIT_MANIFEST_KIND = "do.sqlite.schema" as const;
export const RIPGIT_MANIFEST_MEDIA_TYPE =
  "application/vnd.gsv.ripgit-snapshot-manifest+json" as const;
export const RIPGIT_PAGE_KIND = "do.sqlite.rows" as const;
export const RIPGIT_PAGE_MEDIA_TYPE =
  "application/vnd.gsv.ripgit-snapshot-page+json" as const;
export const RIPGIT_MAX_PAGE_ROWS = 250 as const;
export const RIPGIT_MAX_SAFE_SQL_INTEGER = Number.MAX_SAFE_INTEGER;

export type RipgitSnapshotColumnType = "TEXT" | "INTEGER" | "BLOB";

export type RipgitSnapshotTableLayoutV1 = Readonly<{
  name: string;
  columns: readonly string[];
  columnTypes: readonly RipgitSnapshotColumnType[];
}>;

export const RIPGIT_SNAPSHOT_TABLE_LAYOUT: readonly RipgitSnapshotTableLayoutV1[] =
  deepFreezeLayouts([
    table("config", ["key", "value"], ["TEXT", "TEXT"]),
    table(
      "blob_groups",
      ["group_id", "path_hint", "latest_version"],
      ["INTEGER", "TEXT", "INTEGER"],
    ),
    table(
      "commits",
      [
        "hash",
        "tree_hash",
        "author",
        "author_email",
        "author_time",
        "committer",
        "committer_email",
        "commit_time",
        "message",
      ],
      [
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "INTEGER",
        "TEXT",
        "TEXT",
        "INTEGER",
        "TEXT",
      ],
    ),
    table(
      "commit_parents",
      ["commit_hash", "parent_hash", "ordinal"],
      ["TEXT", "TEXT", "INTEGER"],
    ),
    table(
      "trees",
      ["tree_hash", "name", "mode", "entry_hash"],
      ["TEXT", "TEXT", "INTEGER", "TEXT"],
    ),
    table(
      "blobs",
      [
        "blob_hash",
        "group_id",
        "version_in_group",
        "is_keyframe",
        "data",
        "raw_size",
        "stored_size",
      ],
      ["TEXT", "INTEGER", "INTEGER", "INTEGER", "BLOB", "INTEGER", "INTEGER"],
    ),
    table(
      "blob_chunks",
      ["group_id", "version_in_group", "chunk_index", "data"],
      ["INTEGER", "INTEGER", "INTEGER", "BLOB"],
    ),
    table("raw_objects", ["hash", "data"], ["TEXT", "BLOB"]),
    table("refs", ["name", "commit_hash"], ["TEXT", "TEXT"]),
    table(
      "issues",
      [
        "id",
        "number",
        "kind",
        "title",
        "body",
        "author_id",
        "author_name",
        "state",
        "source_branch",
        "target_branch",
        "source_hash",
        "merge_commit_hash",
        "created_at",
        "updated_at",
      ],
      [
        "INTEGER",
        "INTEGER",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "TEXT",
        "INTEGER",
        "INTEGER",
      ],
    ),
    table(
      "issue_comments",
      ["id", "issue_id", "author_id", "author_name", "body", "created_at", "updated_at"],
      ["INTEGER", "INTEGER", "TEXT", "TEXT", "TEXT", "INTEGER", "INTEGER"],
    ),
  ]);

export const RIPGIT_REBUILT_DERIVED_TABLES = Object.freeze([
  "commit_graph",
  "fts_head",
  "fts_commits",
] as const);

export const RIPGIT_EXCLUDED_CACHE_TABLES = Object.freeze([
  "package_build_cache",
  "package_npm_cache",
] as const);

export type RipgitRepositoryIdentityV1 = Readonly<{
  owner: string;
  repo: string;
}>;

export type RipgitSnapshotValueV1 =
  | Readonly<{ type: "null" }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "integer"; value: string }>
  | Readonly<{ type: "float_bits"; value: string }>
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "blob_base64"; value: string }>;

export type RipgitSnapshotTableV1 = Readonly<{
  name: string;
  columns: readonly string[];
  columnTypes: readonly string[];
  rowCount: number;
}>;

export type RipgitSnapshotManifestBodyV1 = Readonly<{
  format: typeof RIPGIT_SNAPSHOT_FORMAT;
  identity: RipgitRepositoryIdentityV1;
  sourceEpoch: number;
  tables: readonly RipgitSnapshotTableV1[];
  rebuiltDerivedTables: readonly string[];
  excludedCacheTables: readonly string[];
}>;

export type RipgitSnapshotManifestV1 = Readonly<{
  body: RipgitSnapshotManifestBodyV1;
  manifestHash: string;
}>;

export type RipgitSnapshotPageBodyV1 = Readonly<{
  manifestHash: string;
  tableIndex: number;
  table: string;
  offset: number;
  nextOffset: number;
  rows: readonly (readonly RipgitSnapshotValueV1[])[];
}>;

export type RipgitSnapshotPageV1 = Readonly<{
  body: RipgitSnapshotPageBodyV1;
  pageHash: string;
}>;

export type RipgitSnapshotStreamValidationOptions = Readonly<{
  objectId: string;
  logicalName?: string;
  crypto?: PortableCrypto;
}>;

export type RipgitSnapshotStreamValidationResult = Readonly<{
  objectId: string;
  manifest: RipgitSnapshotManifestV1;
  pageCount: number;
  rowCount: number;
  sqlite: ArchiveSqliteInventoryV1;
}>;

/** Decode and authenticate one canonical ripgit manifest archive frame. */
export async function decodeRipgitSnapshotManifestFrame(
  frame: ArchiveDataFrameInput,
  options: Readonly<{ crypto?: PortableCrypto }> = {},
): Promise<RipgitSnapshotManifestV1> {
  assertFrameEnvelope(
    frame,
    RIPGIT_MANIFEST_KIND,
    RIPGIT_MANIFEST_MEDIA_TYPE,
    0,
    "manifest",
  );
  const manifest = decodeManifest(parseCanonicalJson(frame.body, {
    maxBytes: MAX_FRAME_BODY_BYTES,
  }));
  const actual = await computeRipgitSnapshotManifestHash(manifest.body, options);
  if (manifest.manifestHash !== actual) {
    fail("integrity_error", "ripgit snapshot manifest hash does not match its body");
  }
  return manifest;
}

/** Decode and authenticate one canonical ripgit page archive frame. */
export async function decodeRipgitSnapshotPageFrame(
  frame: ArchiveDataFrameInput,
  options: Readonly<{ crypto?: PortableCrypto }> = {},
): Promise<RipgitSnapshotPageV1> {
  assertFrameEnvelope(
    frame,
    RIPGIT_PAGE_KIND,
    RIPGIT_PAGE_MEDIA_TYPE,
    undefined,
    "page",
  );
  const page = decodePage(parseCanonicalJson(frame.body, {
    maxBytes: MAX_FRAME_BODY_BYTES,
  }));
  const actual = await computeRipgitSnapshotPageHash(page.body, options);
  if (page.pageHash !== actual) {
    fail("integrity_error", "ripgit snapshot page hash does not match its body");
  }
  return page;
}

/** Rust hashes typed struct JSON in declaration order, not canonical frame JSON. */
export async function computeRipgitSnapshotManifestHash(
  body: RipgitSnapshotManifestBodyV1,
  options: Readonly<{ crypto?: PortableCrypto }> = {},
): Promise<string> {
  const decoded = decodeManifestBody(body);
  return hex(await sha256(structJsonBytes(orderedManifestBody(decoded)), options.crypto));
}

/** Rust hashes typed struct JSON in declaration order, not canonical frame JSON. */
export async function computeRipgitSnapshotPageHash(
  body: RipgitSnapshotPageBodyV1,
  options: Readonly<{ crypto?: PortableCrypto }> = {},
): Promise<string> {
  const decoded = decodePageBody(body);
  return hex(await sha256(structJsonBytes(orderedPageBody(decoded)), options.crypto));
}

/**
 * Validate one complete ripgit-repository object without buffering its pages.
 * Frames must be observed serially. The manifest is first, all page parts and
 * row ranges are contiguous, and finish succeeds only after every declared row.
 */
export class RipgitSnapshotStreamValidator {
  readonly #objectId: string;
  readonly #logicalName?: string;
  readonly #crypto?: PortableCrypto;
  #manifest: RipgitSnapshotManifestV1 | null = null;
  #expectedTableIndex = 0;
  #expectedOffset = 0;
  #pageCount = 0;
  #rowCount = 0;
  #busy = false;
  #finished = false;
  #failure: unknown;

  constructor(options: RipgitSnapshotStreamValidationOptions) {
    this.#objectId = validateObjectId(options.objectId);
    this.#logicalName = options.logicalName;
    this.#crypto = options.crypto;
    if (this.#logicalName !== undefined) validateLogicalName(this.#logicalName);
  }

  async observe(
    frame: ArchiveDataFrameInput,
  ): Promise<RipgitSnapshotManifestV1 | RipgitSnapshotPageV1> {
    if (this.#finished) fail("invalid_argument", "ripgit snapshot validation is finalized");
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#busy) fail("invalid_argument", "ripgit snapshot frames must be observed serially");
    this.#busy = true;
    try {
      if (frame.objectId !== this.#objectId) {
        fail("invalid_frame", "ripgit snapshot frame belongs to another archive object");
      }
      if (!this.#manifest) {
        const manifest = await decodeRipgitSnapshotManifestFrame(frame, {
          crypto: this.#crypto,
        });
        if (
          this.#logicalName !== undefined
          && `${manifest.body.identity.owner}/${manifest.body.identity.repo}` !== this.#logicalName
        ) {
          fail("invalid_frame", "ripgit snapshot logical repository identity does not match");
        }
        this.#manifest = manifest;
        this.#advanceCompletedTables();
        return manifest;
      }

      if (frame.part !== this.#pageCount) {
        fail("invalid_frame", "ripgit snapshot page parts must be contiguous from zero");
      }
      if (this.#pageCount === 0xffff_ffff) {
        fail("limit_exceeded", "ripgit snapshot page part range is exhausted");
      }
      const page = await decodeRipgitSnapshotPageFrame(frame, { crypto: this.#crypto });
      this.#validatePage(page);
      this.#pageCount = checkedIncrement(this.#pageCount, "ripgit page count");
      this.#rowCount = checkedAdd(this.#rowCount, page.body.rows.length, "ripgit row count");
      this.#expectedOffset = page.body.nextOffset;
      this.#advanceCompletedTables();
      return page;
    } catch (error) {
      this.#failure = error;
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async *observeFrames(
    frames: Iterable<ArchiveDataFrameInput> | AsyncIterable<ArchiveDataFrameInput>,
  ): AsyncGenerator<ArchiveDataFrameInput> {
    for await (const frame of frames) {
      await this.observe(frame);
      yield frame;
    }
  }

  finish(): RipgitSnapshotStreamValidationResult {
    if (this.#finished) fail("invalid_argument", "ripgit snapshot validation is finalized");
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#busy) fail("invalid_argument", "ripgit snapshot cannot finish during observation");
    const manifest = this.#manifest;
    if (!manifest) fail("invalid_frame", "ripgit snapshot is missing its manifest frame");
    this.#advanceCompletedTables();
    if (this.#expectedTableIndex !== RIPGIT_SNAPSHOT_TABLE_LAYOUT.length) {
      fail("invalid_frame", "ripgit snapshot ended before all declared rows were covered");
    }
    this.#finished = true;
    return Object.freeze({
      objectId: this.#objectId,
      manifest,
      pageCount: this.#pageCount,
      rowCount: this.#rowCount,
      sqlite: ripgitSqliteInventory(manifest),
    });
  }

  #validatePage(page: RipgitSnapshotPageV1): void {
    const manifest = this.#manifest;
    if (!manifest) fail("invalid_frame", "ripgit snapshot manifest must precede pages");
    const layout = RIPGIT_SNAPSHOT_TABLE_LAYOUT[this.#expectedTableIndex];
    if (!layout) fail("invalid_frame", "ripgit snapshot contains rows after completion");
    if (page.body.manifestHash !== manifest.manifestHash) {
      fail("integrity_error", "ripgit snapshot page belongs to another manifest");
    }
    if (
      page.body.tableIndex !== this.#expectedTableIndex
      || page.body.table !== layout.name
      || page.body.offset !== this.#expectedOffset
    ) {
      fail("invalid_frame", "ripgit snapshot page is out of table or offset order");
    }
    if (page.body.rows.length === 0) {
      fail("invalid_frame", "ripgit snapshot pages must contain at least one row");
    }
    const expectedNext = checkedAdd(
      this.#expectedOffset,
      page.body.rows.length,
      "ripgit page offset",
    );
    const declaredRows = manifest.body.tables[this.#expectedTableIndex]!.rowCount;
    if (page.body.nextOffset !== expectedNext || expectedNext > declaredRows) {
      fail("invalid_frame", "ripgit snapshot page range does not match the manifest");
    }
  }

  #advanceCompletedTables(): void {
    const tables = this.#manifest?.body.tables;
    if (!tables) return;
    while (
      this.#expectedTableIndex < tables.length
      && this.#expectedOffset === tables[this.#expectedTableIndex]!.rowCount
    ) {
      this.#expectedTableIndex += 1;
      this.#expectedOffset = 0;
    }
  }
}

/** Convert ripgit's fixed table order into the archive manifest's sorted inventory. */
export function ripgitSqliteInventory(
  manifest: RipgitSnapshotManifestV1,
): ArchiveSqliteInventoryV1 {
  const body = decodeManifestBody(manifest.body);
  const tables: ArchiveSqliteTableV1[] = body.tables
    .map((entry) => Object.freeze({
      name: entry.name,
      rowCount: entry.rowCount.toString(10),
    }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Object.freeze({ tables: Object.freeze(tables) });
}

function decodeManifest(value: unknown): RipgitSnapshotManifestV1 {
  const record = exactRecord(value, ["body", "manifestHash"], "ripgit manifest");
  const body = decodeManifestBody(record.body);
  const manifestHash = hashString(record.manifestHash, "ripgit manifestHash");
  return Object.freeze({ body, manifestHash });
}

function decodeManifestBody(value: unknown): RipgitSnapshotManifestBodyV1 {
  const record = exactRecord(
    value,
    [
      "excludedCacheTables",
      "format",
      "identity",
      "rebuiltDerivedTables",
      "sourceEpoch",
      "tables",
    ],
    "ripgit manifest body",
  );
  if (record.format !== RIPGIT_SNAPSHOT_FORMAT) {
    fail("invalid_frame", "ripgit snapshot format is unsupported");
  }
  const identity = decodeIdentity(record.identity);
  const sourceEpoch = safeNonnegativeInteger(record.sourceEpoch, "ripgit sourceEpoch");
  if (!Array.isArray(record.tables) || record.tables.length !== RIPGIT_SNAPSHOT_TABLE_LAYOUT.length) {
    fail("invalid_frame", "ripgit snapshot table layout is incomplete");
  }
  const tables = record.tables.map((entry, index) => decodeTable(entry, index));
  tables.reduce(
    (total, entry) => checkedAdd(total, entry.rowCount, "ripgit manifest row count"),
    0,
  );
  const rebuiltDerivedTables = exactStringArray(
    record.rebuiltDerivedTables,
    RIPGIT_REBUILT_DERIVED_TABLES,
    "ripgit rebuiltDerivedTables",
  );
  const excludedCacheTables = exactStringArray(
    record.excludedCacheTables,
    RIPGIT_EXCLUDED_CACHE_TABLES,
    "ripgit excludedCacheTables",
  );
  return Object.freeze({
    format: RIPGIT_SNAPSHOT_FORMAT,
    identity,
    sourceEpoch,
    tables: Object.freeze(tables),
    rebuiltDerivedTables,
    excludedCacheTables,
  });
}

function decodeIdentity(value: unknown): RipgitRepositoryIdentityV1 {
  const record = exactRecord(value, ["owner", "repo"], "ripgit identity");
  const owner = identityPart(record.owner, "owner");
  const repo = identityPart(record.repo, "repository");
  return Object.freeze({ owner, repo });
}

function decodeTable(value: unknown, index: number): RipgitSnapshotTableV1 {
  const record = exactRecord(
    value,
    ["columnTypes", "columns", "name", "rowCount"],
    "ripgit snapshot table",
  );
  const expected = RIPGIT_SNAPSHOT_TABLE_LAYOUT[index]!;
  if (record.name !== expected.name) {
    fail("invalid_frame", "ripgit snapshot table order or name is unsupported");
  }
  const columns = exactStringArray(record.columns, expected.columns, `${expected.name} columns`);
  const columnTypes = exactStringArray(
    record.columnTypes,
    expected.columnTypes,
    `${expected.name} columnTypes`,
  );
  const rowCount = safeNonnegativeInteger(record.rowCount, `${expected.name} rowCount`);
  return Object.freeze({ name: expected.name, columns, columnTypes, rowCount });
}

function decodePage(value: unknown): RipgitSnapshotPageV1 {
  const record = exactRecord(value, ["body", "pageHash"], "ripgit page");
  const body = decodePageBody(record.body);
  const pageHash = hashString(record.pageHash, "ripgit pageHash");
  return Object.freeze({ body, pageHash });
}

function decodePageBody(value: unknown): RipgitSnapshotPageBodyV1 {
  const record = exactRecord(
    value,
    ["manifestHash", "nextOffset", "offset", "rows", "table", "tableIndex"],
    "ripgit page body",
  );
  const manifestHash = hashString(record.manifestHash, "ripgit page manifestHash");
  const tableIndex = safeNonnegativeInteger(record.tableIndex, "ripgit page tableIndex");
  const layout = RIPGIT_SNAPSHOT_TABLE_LAYOUT[tableIndex];
  if (!layout || record.table !== layout.name) {
    fail("invalid_frame", "ripgit page table identity is unsupported");
  }
  const offset = safeNonnegativeInteger(record.offset, "ripgit page offset");
  const nextOffset = safeNonnegativeInteger(record.nextOffset, "ripgit page nextOffset");
  if (!Array.isArray(record.rows)) fail("invalid_frame", "ripgit page rows must be an array");
  if (record.rows.length > RIPGIT_MAX_PAGE_ROWS) {
    fail("limit_exceeded", "ripgit snapshot pages may contain at most 250 rows");
  }
  const rows = record.rows.map((rawRow) => decodeRow(rawRow, layout));
  return Object.freeze({
    manifestHash,
    tableIndex,
    table: layout.name,
    offset,
    nextOffset,
    rows: Object.freeze(rows),
  });
}

function decodeRow(
  value: unknown,
  layout: RipgitSnapshotTableLayoutV1,
): readonly RipgitSnapshotValueV1[] {
  if (!Array.isArray(value) || value.length !== layout.columns.length) {
    fail("invalid_frame", `ripgit ${layout.name} row does not match its column layout`);
  }
  const row = value.map((entry, index) => {
    const decoded = decodeSnapshotValue(entry);
    validateColumnValue(layout, index, decoded);
    return decoded;
  });
  return Object.freeze(row);
}

function decodeSnapshotValue(value: unknown): RipgitSnapshotValueV1 {
  const record = recordValue(value, "ripgit snapshot value");
  switch (record.type) {
    case "null":
      requireExactKeys(record, ["type"], "ripgit null value");
      return Object.freeze({ type: "null" });
    case "boolean":
      requireExactKeys(record, ["type", "value"], "ripgit boolean value");
      if (typeof record.value !== "boolean") fail("invalid_frame", "ripgit boolean is invalid");
      return Object.freeze({ type: "boolean", value: record.value });
    case "integer": {
      requireExactKeys(record, ["type", "value"], "ripgit integer value");
      const integer = signedI64String(record.value, "ripgit integer");
      return Object.freeze({ type: "integer", value: integer });
    }
    case "float_bits": {
      requireExactKeys(record, ["type", "value"], "ripgit float value");
      if (typeof record.value !== "string" || !/^[0-9a-f]{16}$/.test(record.value)) {
        fail("invalid_frame", "ripgit float bits are invalid");
      }
      return Object.freeze({ type: "float_bits", value: record.value });
    }
    case "string":
      requireExactKeys(record, ["type", "value"], "ripgit string value");
      if (typeof record.value !== "string") fail("invalid_frame", "ripgit string is invalid");
      return Object.freeze({ type: "string", value: record.value });
    case "blob_base64":
      requireExactKeys(record, ["type", "value"], "ripgit blob value");
      if (typeof record.value !== "string" || !isCanonicalStandardBase64(record.value)) {
        fail("invalid_frame", "ripgit blob uses invalid canonical standard base64");
      }
      return Object.freeze({ type: "blob_base64", value: record.value });
    default:
      fail("invalid_frame", "ripgit snapshot value tag is unsupported");
  }
}

function validateColumnValue(
  layout: RipgitSnapshotTableLayoutV1,
  index: number,
  value: RipgitSnapshotValueV1,
): void {
  if (value.type === "null") return;
  const expected = layout.columnTypes[index];
  const valid =
    (expected === "INTEGER"
      && value.type === "integer"
      && absoluteBigInt(value.value) <= BigInt(RIPGIT_MAX_SAFE_SQL_INTEGER))
    || (expected === "TEXT" && value.type === "string")
    || (expected === "BLOB" && value.type === "blob_base64");
  if (!valid) {
    fail(
      "invalid_frame",
      `ripgit value for ${layout.name}.${layout.columns[index]} is not losslessly portable`,
    );
  }
}

function orderedManifestBody(body: RipgitSnapshotManifestBodyV1): object {
  return {
    format: body.format,
    identity: {
      owner: body.identity.owner,
      repo: body.identity.repo,
    },
    sourceEpoch: body.sourceEpoch,
    tables: body.tables.map((entry) => ({
      name: entry.name,
      columns: [...entry.columns],
      columnTypes: [...entry.columnTypes],
      rowCount: entry.rowCount,
    })),
    rebuiltDerivedTables: [...body.rebuiltDerivedTables],
    excludedCacheTables: [...body.excludedCacheTables],
  };
}

function orderedPageBody(body: RipgitSnapshotPageBodyV1): object {
  return {
    manifestHash: body.manifestHash,
    tableIndex: body.tableIndex,
    table: body.table,
    offset: body.offset,
    nextOffset: body.nextOffset,
    rows: body.rows.map((row) => row.map(orderedSnapshotValue)),
  };
}

function orderedSnapshotValue(value: RipgitSnapshotValueV1): object {
  return value.type === "null"
    ? { type: value.type }
    : { type: value.type, value: value.value };
}

function structJsonBytes(value: object): Uint8Array {
  const text = JSON.stringify(value);
  if (text === undefined) fail("invalid_value", "ripgit hash input cannot be serialized");
  return new TextEncoder().encode(text);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = recordValue(value, label);
  requireExactKeys(record, keys, label);
  return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_frame", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("invalid_frame", `${label} has unexpected or missing fields`);
  }
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])
  ) {
    fail("invalid_frame", `${label} does not match the ripgit v1 layout`);
  }
  return Object.freeze([...expected]);
}

function safeNonnegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    fail("invalid_frame", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function signedI64String(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) {
    fail("invalid_frame", `${label} must be a signed 64-bit decimal string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    fail("invalid_frame", `${label} must be a signed 64-bit decimal string`);
  }
  if (parsed < -9_223_372_036_854_775_808n || parsed > 9_223_372_036_854_775_807n) {
    fail("invalid_frame", `${label} is outside the signed 64-bit range`);
  }
  return value;
}

function identityPart(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > 512
    || value.includes("/")
    || /\p{Cc}/u.test(value)
  ) {
    fail("invalid_frame", `ripgit repository ${label} is invalid`);
  }
  return value;
}

function validateLogicalName(value: string): void {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) {
    fail("invalid_argument", "ripgit logicalName must be owner/repository");
  }
  identityPart(value.slice(0, slash), "owner");
  identityPart(value.slice(slash + 1), "repository");
}

function validateObjectId(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > 1024
    || /\p{Cc}/u.test(value)
  ) {
    fail("invalid_argument", "ripgit archive objectId is invalid");
  }
  return value;
}

function hashString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("invalid_frame", `${label} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

function assertFrameEnvelope(
  frame: ArchiveDataFrameInput,
  kind: typeof RIPGIT_MANIFEST_KIND | typeof RIPGIT_PAGE_KIND,
  mediaType: typeof RIPGIT_MANIFEST_MEDIA_TYPE | typeof RIPGIT_PAGE_MEDIA_TYPE,
  part: number | undefined,
  label: string,
): void {
  if (
    frame.kind !== kind
    || (part !== undefined && frame.part !== part)
    || !Number.isInteger(frame.part)
    || frame.part < 0
    || frame.part > 0xffff_ffff
    || frame.bodyMediaType !== mediaType
    || (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity")
    || !(frame.body instanceof Uint8Array)
    || frame.body.byteLength > MAX_FRAME_BODY_BYTES
  ) {
    fail("invalid_frame", `ripgit snapshot ${label} frame envelope is invalid`);
  }
  if (
    typeof frame.objectId !== "string"
    || frame.objectId.length === 0
    || new TextEncoder().encode(frame.objectId).byteLength > 1024
    || /\p{Cc}/u.test(frame.objectId)
  ) {
    fail("invalid_frame", `ripgit snapshot ${label} frame objectId is invalid`);
  }
}

function isCanonicalStandardBase64(value: string): boolean {
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  if (value.endsWith("==")) {
    const sextet = base64Sextet(value.charCodeAt(value.length - 3));
    return sextet >= 0 && (sextet & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    const sextet = base64Sextet(value.charCodeAt(value.length - 2));
    return sextet >= 0 && (sextet & 0x03) === 0;
  }
  return true;
}

function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function absoluteBigInt(value: string): bigint {
  const parsed = BigInt(value);
  return parsed < 0n ? -parsed : parsed;
}

function checkedIncrement(value: number, label: string): number {
  return checkedAdd(value, 1, label);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("limit_exceeded", `${label} exceeds safe bounds`);
  return result;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function table(
  name: string,
  columns: readonly string[],
  columnTypes: readonly RipgitSnapshotColumnType[],
): RipgitSnapshotTableLayoutV1 {
  return { name, columns, columnTypes };
}

function deepFreezeLayouts(
  layouts: RipgitSnapshotTableLayoutV1[],
): readonly RipgitSnapshotTableLayoutV1[] {
  return Object.freeze(layouts.map((layout) => Object.freeze({
    name: layout.name,
    columns: Object.freeze([...layout.columns]),
    columnTypes: Object.freeze([...layout.columnTypes]),
  })));
}
