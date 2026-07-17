import {
  canonicalJsonBytes,
  concatBytes,
  decodeKvValue,
  decodePortableString,
  decodeSqliteTextUtf8,
  decodeSqliteValue,
  encodeBase64Url,
  encodeU32,
  encodeU64,
  parseCanonicalJson,
  sha256Parts,
  type DecodedSqliteValue,
} from "@humansandmachines/gsv-portable-archive";
import {
  decodeDescriptorRecord,
  decodeKvRecord,
  decodeRowsRecord,
  decodeSchemaRecord,
} from "./portable-do-records";
import {
  inspectPortableSqliteSchema,
  NonPortableDoError,
  quoteIdentifier,
  validateExcludedSqlTables,
} from "./portable-do-schema";
import type {
  DoDescriptorBodyV1,
  DoKvBodyV1,
  DoSqliteRowsBodyV1,
  DoSqliteSchemaBodyV1,
  DoSqliteTableV1,
  LogicalDoRestoreOptions,
  LogicalDoRestoreTranscript,
  LogicalDoSnapshotFrame,
  LogicalDoSqlValue,
  LogicalDoStorage,
} from "./portable-do-types";
import { validatePortableDoIdentifier } from "./portable-do-identifiers";
import {
  DO_DESCRIPTOR_MEDIA_TYPE,
  DO_KV_MEDIA_TYPE,
  DO_SQLITE_CELL_MEDIA_TYPE,
  DO_SQLITE_ROWS_MEDIA_TYPE,
  DO_SQLITE_SCHEMA_MEDIA_TYPE,
  MANAGED_KV_PREFIX,
  RESTORE_JOURNAL_PREFIX,
} from "./portable-do-types";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_CELL_PART_BYTES = 1024 * 1024;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

type RestoreState = "accepting" | "database-finalized";
type RestorableFrameKind = LogicalDoSnapshotFrame["kind"];

type RestoreTranscriptV1 = LogicalDoRestoreTranscript & Readonly<{
  version: 1;
}>;

type RestoreBindingV1 = Readonly<{
  version: 1;
  restoreId: string;
  objectId: string;
  schemaMode: "empty" | "fresh-migrated";
  preservedSqlTables: readonly string[];
  preservedKvPrefixes: readonly string[];
  transcript: RestoreTranscriptV1 | null;
}>;

// Journal v1 did not bind a transcript and cannot be upgraded safely in
// place. A version mismatch fails closed so the orchestrator can discard the
// fenced target and retry with a fresh object.
type RestoreSessionV2 = {
  version: 2;
  binding: RestoreBindingV1;
  state: RestoreState;
  transcriptVerified: boolean;
  descriptor: DoDescriptorBodyV1 | null;
  schemaApplied: boolean;
  tableCount: number;
  indexCount: number;
  sequenceCount: number;
  restoredRows: string;
  restoredKvEntries: string;
  nextParts: Record<RestorableFrameKind, number>;
};

type TableProgressV1 = {
  version: 1;
  nextPage: string;
  restoredRows: string;
};

type CompletionV2 = {
  version: 2;
  binding: RestoreBindingV1;
  completedAt: number;
};

type ResolvedRestoreOptions = Omit<LogicalDoRestoreOptions, "transcript"> & Readonly<{
  schemaMode: "empty" | "fresh-migrated";
  preservedSqlTables: readonly string[];
  preservedKvPrefixes: readonly string[];
  transcript: RestoreTranscriptV1 | null;
}>;

type ParsedFrame =
  | Readonly<{ kind: "do.descriptor"; body: DoDescriptorBodyV1 }>
  | Readonly<{ kind: "do.sqlite.schema"; body: DoSqliteSchemaBodyV1 }>
  | Readonly<{ kind: "do.sqlite.rows"; body: DoSqliteRowsBodyV1 }>
  | Readonly<{ kind: "do.sqlite.cell"; body: Uint8Array }>
  | Readonly<{ kind: "do.kv"; body: DoKvBodyV1 }>;

export type LogicalDoRestoreApplyResult = "applied" | "replayed";
export type LogicalDoRestorePhase = "accepting" | "finalizing" | "complete";
export type LogicalDurableObjectRestore = Readonly<{
  phase: LogicalDoRestorePhase;
  applyFrame(frame: LogicalDoSnapshotFrame): Promise<LogicalDoRestoreApplyResult>;
  /** Stream-bound restores supply the independently verified transcript once. */
  finalize(transcript?: LogicalDoRestoreTranscript): Promise<void>;
}>;

/** Begins or resumes a fenced logical restore into an otherwise empty object. */
export async function beginLogicalDurableObjectRestore(
  storage: LogicalDoStorage,
  options: LogicalDoRestoreOptions,
): Promise<LogicalDurableObjectRestore> {
  const resolved = resolveRestoreOptions(options);
  validatePortableDoIdentifier(resolved.restoreId, "restore restoreId");
  validatePortableDoIdentifier(resolved.objectId, "restore objectId");
  resolved.fence.assertFenced();
  const alarm = await storage.getAlarm();
  resolved.fence.assertFenced();

  const keys = restoreKeys(resolved.restoreId);
  const completed = storage.kv.get<CompletionV2>(keys.complete);
  if (completed !== undefined) {
    assertCompletion(completed, resolved);
    return new LogicalDurableObjectRestoreSession(storage, resolved, keys, "complete");
  }

  const phase = storage.transactionSync<LogicalDoRestorePhase>(() => {
    const existing = storage.kv.get<RestoreSessionV2>(keys.session);
    if (existing !== undefined) {
      assertSession(existing, resolved);
      return existing.state === "database-finalized" ? "finalizing" : "accepting";
    }
    assertRestoreSqlTarget(storage, resolved);
    if (alarm !== null) {
      restoreError("restore_target_not_empty", "Logical restore target has an alarm");
    }
    for (const [key] of storage.kv.list()) {
      if (!resolved.preservedKvPrefixes.some((prefix) => key.startsWith(prefix))) {
        restoreError(
          "restore_target_not_empty",
          `Logical restore target has non-preserved DO KV key ${JSON.stringify(key)}`,
        );
      }
    }
    storage.kv.put(keys.session, initialSession(resolved));
    return "accepting";
  });

  return new LogicalDurableObjectRestoreSession(storage, resolved, keys, phase);
}

class LogicalDurableObjectRestoreSession implements LogicalDurableObjectRestore {
  readonly #storage: LogicalDoStorage;
  readonly #options: ResolvedRestoreOptions;
  readonly #keys: ReturnType<typeof restoreKeys>;
  #phase: LogicalDoRestorePhase;

  get phase(): LogicalDoRestorePhase {
    return this.#phase;
  }

  constructor(
    storage: LogicalDoStorage,
    options: ResolvedRestoreOptions,
    keys: ReturnType<typeof restoreKeys>,
    phase: LogicalDoRestorePhase,
  ) {
    this.#storage = storage;
    this.#options = options;
    this.#keys = keys;
    this.#phase = phase;
  }

  async applyFrame(frame: LogicalDoSnapshotFrame): Promise<LogicalDoRestoreApplyResult> {
    this.#options.fence.assertFenced();
    if (this.#phase === "complete") {
      restoreError("restore_conflict", "Logical restore is already complete");
    }
    validateFrameEnvelope(frame, this.#options.objectId);
    const parsed = parseFrame(frame, this.#options.objectId);
    const kvMarkers = parsed.kind === "do.kv"
      ? await Promise.all(
          parsed.body.entries.map(async (entry) =>
            encodeBase64Url(await sha256Parts([canonicalJsonBytes(entry.key)])),
          ),
        )
      : undefined;
    const digestMetadata = canonicalJsonBytes({
      kind: frame.kind,
      objectId: frame.objectId,
      part: frame.part,
      bodyMediaType: frame.bodyMediaType,
      bodyEncoding: frame.bodyEncoding ?? "identity",
    });
    const digest = encodeBase64Url(
      await sha256Parts([
        encodeU32(digestMetadata.byteLength),
        digestMetadata,
        encodeU64(BigInt(frame.body.byteLength)),
        frame.body,
      ]),
    );
    this.#options.fence.assertFenced();

    return this.#storage.transactionSync(() => {
      const session = this.#session();
      if (session.state !== "accepting") {
        restoreError("restore_conflict", "Logical restore no longer accepts data frames");
      }
      const journalKey = this.#keys.frame(frame.kind, frame.part);
      const existingDigest = this.#storage.kv.get<string>(journalKey);
      if (existingDigest !== undefined) {
        if (existingDigest !== digest) {
          restoreError("restore_conflict", "Logical restore frame replay has different content");
        }
        return "replayed";
      }
      const expectedPart = session.nextParts[frame.kind];
      if (frame.part !== expectedPart) {
        restoreError(
          "restore_conflict",
          `Logical restore expected ${frame.kind} part ${expectedPart}, received ${frame.part}`,
        );
      }

      this.#applyParsedFrame(session, frame.part, parsed, kvMarkers);
      session.nextParts[frame.kind] = expectedPart + 1;
      this.#storage.kv.put(journalKey, digest);
      this.#storage.kv.put(this.#keys.session, session);
      return "applied";
    });
  }

  async finalize(transcript?: LogicalDoRestoreTranscript): Promise<void> {
    this.#options.fence.assertFenced();
    const evidence = transcript === undefined ? undefined : resolveRestoreTranscript(transcript);
    if (this.#phase === "complete") {
      assertTranscriptEvidence(this.#options.transcript, evidence);
      return;
    }

    let descriptor: DoDescriptorBodyV1;
    this.#storage.transactionSync(() => {
      const session = this.#session();
      if (evidence !== undefined) {
        assertTranscriptEvidence(session.binding.transcript, evidence);
        session.transcriptVerified = true;
      }
      if (session.binding.transcript !== null && !session.transcriptVerified) {
        restoreError(
          "restore_incomplete",
          "Logical restore transcript has not been completely verified",
        );
      }
      if (session.descriptor === null || !session.schemaApplied) {
        restoreError("restore_incomplete", "Logical restore is missing its descriptor or schema");
      }
      descriptor = session.descriptor;
      if (session.state === "accepting") {
        this.#finalizeDatabase(session);
        session.state = "database-finalized";
        this.#storage.kv.put(this.#keys.session, session);
      }
    });
    this.#phase = "finalizing";

    const scheduledTime = descriptor!.alarm?.scheduledTime;
    if (scheduledTime === undefined) {
      await this.#storage.deleteAlarm();
    } else {
      const timestamp = Number(scheduledTime);
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        restoreError("invalid_archive_record", "DO alarm timestamp exceeds JavaScript precision");
      }
      await this.#storage.setAlarm(timestamp);
    }
    this.#options.fence.assertFenced();

    while (true) {
      const deleted = this.#storage.transactionSync(() => {
        const session = this.#session();
        if (session.state !== "database-finalized") {
          restoreError("restore_conflict", "Logical restore database finalization was lost");
        }
        const keys = [...this.#storage.kv.list({ prefix: this.#keys.base, limit: 128 })]
          .map(([key]) => key)
          .filter((key) => key !== this.#keys.session);
        for (const key of keys) this.#storage.kv.delete(key);
        return keys.length;
      });
      if (deleted === 0) break;
      this.#options.fence.assertFenced();
    }

    this.#storage.transactionSync(() => {
      const session = this.#session();
      if (session.state !== "database-finalized") {
        restoreError("restore_conflict", "Logical restore database finalization was lost");
      }
      this.#storage.kv.delete(this.#keys.session);
      const completion: CompletionV2 = {
        version: 2,
        binding: restoreBinding(this.#options),
        completedAt: Date.now(),
      };
      this.#storage.kv.put(this.#keys.complete, completion);
    });
    this.#phase = "complete";
  }

  #applyParsedFrame(
    session: RestoreSessionV2,
    part: number,
    frame: ParsedFrame,
    kvMarkers: readonly string[] | undefined,
  ): void {
    switch (frame.kind) {
      case "do.descriptor":
        if (session.descriptor !== null || part !== 0) {
          restoreError("restore_conflict", "Logical restore has more than one descriptor");
        }
        session.descriptor = frame.body;
        return;
      case "do.sqlite.schema":
        this.#applySchema(session, part, frame.body);
        return;
      case "do.sqlite.cell":
        this.#requireSchema(session);
        this.#storage.kv.put(this.#keys.cell(part), copyArrayBuffer(frame.body));
        return;
      case "do.sqlite.rows":
        this.#requireSchema(session);
        this.#applyRows(session, frame.body);
        return;
      case "do.kv":
        this.#requireSchema(session);
        if (kvMarkers === undefined || kvMarkers.length !== frame.body.entries.length) {
          restoreError("restore_conflict", "Logical restore KV journal markers are missing");
        }
        this.#applyKv(session, frame.body, kvMarkers);
        return;
    }
  }

  #applySchema(session: RestoreSessionV2, part: number, schema: DoSqliteSchemaBodyV1): void {
    if (session.descriptor === null || session.schemaApplied || part !== 0) {
      restoreError("restore_conflict", "Logical restore schema arrived out of order");
    }
    if (BigInt(session.descriptor.sqlite.tableCount) !== BigInt(schema.tables.length)) {
      restoreError("invalid_archive_record", "DO descriptor table count does not match schema");
    }
    const schemaRows = schema.tables.reduce((sum, table) => sum + BigInt(table.rowCount), 0n);
    if (BigInt(session.descriptor.sqlite.rowCount) !== schemaRows) {
      restoreError("invalid_archive_record", "DO descriptor row count does not match schema");
    }

    const preservedTables = new Set(this.#options.preservedSqlTables);
    for (const table of schema.tables) {
      if (preservedTables.has(table.name)) {
        restoreError(
          "invalid_archive_record",
          `Archive attempts to replace preserved SQLite table ${JSON.stringify(table.name)}`,
        );
      }
    }

    if (this.#options.schemaMode === "empty") {
      for (const table of schema.tables) this.#storage.sql.exec(table.createSql);
      verifyCreatedTables(this.#storage, schema.tables, this.#options.preservedSqlTables);
    } else {
      const target = inspectPortableSqliteSchema(
        this.#storage.sql,
        this.#options.preservedSqlTables,
      );
      assertMatchingFreshSchema(target, schema);
    }

    schema.tables.forEach((table, index) => {
      this.#storage.kv.put(this.#keys.table(index), table);
      this.#storage.kv.put<TableProgressV1>(this.#keys.tableProgress(index), {
        version: 1,
        nextPage: "0",
        restoredRows: "0",
      });
    });
    schema.indexes.forEach((index, position) => {
      this.#storage.kv.put(this.#keys.index(position), index);
    });
    schema.sequences.forEach((sequence, index) => {
      this.#storage.kv.put(this.#keys.sequence(index), sequence);
    });
    session.tableCount = schema.tables.length;
    session.indexCount = schema.indexes.length;
    session.sequenceCount = schema.sequences.length;
    session.schemaApplied = true;
  }

  #applyRows(session: RestoreSessionV2, body: DoSqliteRowsBodyV1): void {
    let tableIndex: number | undefined;
    let table: DoSqliteTableV1 | undefined;
    for (let index = 0; index < session.tableCount; index += 1) {
      const candidate = this.#storage.kv.get<DoSqliteTableV1>(this.#keys.table(index));
      if (candidate?.name === body.table) {
        tableIndex = index;
        table = candidate;
        break;
      }
    }
    if (tableIndex === undefined || table === undefined) {
      restoreError("invalid_archive_record", `Unknown SQLite table ${JSON.stringify(body.table)}`);
    }
    const progress = this.#storage.kv.get<TableProgressV1>(this.#keys.tableProgress(tableIndex));
    if (progress === undefined) {
      restoreError("restore_conflict", "Logical restore table journal is incomplete");
    }
    if (body.page !== progress.nextPage) {
      restoreError(
        "restore_conflict",
        `SQLite table ${JSON.stringify(body.table)} expected page ${progress.nextPage}, received ${body.page}`,
      );
    }
    for (const row of body.rows) this.#insertRow(table, row.values);
    const added = BigInt(body.rows.length);
    progress.nextPage = (BigInt(progress.nextPage) + 1n).toString();
    progress.restoredRows = (BigInt(progress.restoredRows) + added).toString();
    session.restoredRows = (BigInt(session.restoredRows) + added).toString();
    this.#storage.kv.put(this.#keys.tableProgress(tableIndex), progress);
  }

  #insertRow(table: DoSqliteTableV1, values: DoSqliteRowsBodyV1["rows"][number]["values"]): void {
    if (values.length !== table.insertColumns.length) {
      restoreError(
        "invalid_archive_record",
        `SQLite row for ${JSON.stringify(table.name)} has the wrong column count`,
      );
    }
    const expressions: string[] = [];
    const bindings: LogicalDoSqlValue[] = [];
    for (const encoded of values) {
      const value = decodeSqliteValue(encoded);
      const binding = this.#resolveCell(value);
      expressions.push(binding.expression);
      if (binding.binding !== undefined) bindings.push(binding.binding);
    }
    const columns = table.insertColumns.map(quoteIdentifier).join(", ");
    this.#storage.sql.exec(
      `INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES (${expressions.join(", ")})`,
      ...bindings,
    );
  }

  #resolveCell(value: DecodedSqliteValue): Readonly<{
    expression: string;
    binding?: LogicalDoSqlValue;
  }> {
    if (value === null) return { expression: "?", binding: null };
    if (typeof value === "bigint") {
      return { expression: "CAST(? AS INTEGER)", binding: value.toString() };
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) {
        restoreError("invalid_archive_record", "SQLite cannot preserve a NaN storage value");
      }
      if (value === Number.POSITIVE_INFINITY) return { expression: "9e999" };
      if (value === Number.NEGATIVE_INFINITY) return { expression: "-9e999" };
      return { expression: "?", binding: value };
    }
    if (typeof value === "string") return { expression: "?", binding: value };
    if (value instanceof Uint8Array) {
      return { expression: "?", binding: copyArrayBuffer(value) };
    }

    if (value.objectId !== this.#options.objectId) {
      restoreError("invalid_archive_record", "SQLite cell reference points to another object");
    }
    const parts: Uint8Array[] = [];
    for (let part = 0; part < value.partCount; part += 1) {
      const cellPart = value.firstPart + part;
      const stored = this.#storage.kv.get<ArrayBuffer | Uint8Array>(this.#keys.cell(cellPart));
      if (stored === undefined) {
        restoreError("restore_incomplete", `SQLite cell part ${cellPart} is missing`);
      }
      parts.push(stored instanceof Uint8Array ? stored : new Uint8Array(stored));
    }
    const bytes = concatBytes(parts);
    if (BigInt(bytes.byteLength) !== value.byteLength) {
      restoreError("invalid_archive_record", "SQLite external cell byte length does not match");
    }
    for (let part = 0; part < value.partCount; part += 1) {
      this.#storage.kv.delete(this.#keys.cell(value.firstPart + part));
    }
    if (value.type === "text-ref") {
      return { expression: "?", binding: decodeSqliteTextUtf8(bytes) };
    }
    return { expression: "?", binding: copyArrayBuffer(bytes) };
  }

  #applyKv(
    session: RestoreSessionV2,
    body: DoKvBodyV1,
    markers: readonly string[],
  ): void {
    body.entries.forEach((entry, index) => {
      const key = decodePortableString(entry.key);
      const marker = this.#keys.kvKey(markers[index]!);
      if (this.#storage.kv.get<boolean>(marker) !== undefined) {
        restoreError("invalid_archive_record", `Duplicate DO KV key ${JSON.stringify(key)}`);
      }
      this.#storage.kv.put(key, decodeKvValue(entry.value));
      this.#storage.kv.put(marker, true);
    });
    session.restoredKvEntries = (
      BigInt(session.restoredKvEntries) + BigInt(body.entries.length)
    ).toString();
  }

  #finalizeDatabase(session: RestoreSessionV2): void {
    const descriptor = session.descriptor!;
    if (session.restoredRows !== descriptor.sqlite.rowCount) {
      restoreError(
        "restore_incomplete",
        `Logical restore has ${session.restoredRows} of ${descriptor.sqlite.rowCount} SQLite rows`,
      );
    }
    if (session.restoredKvEntries !== descriptor.kv.entryCount) {
      restoreError(
        "restore_incomplete",
        `Logical restore has ${session.restoredKvEntries} of ${descriptor.kv.entryCount} DO KV entries`,
      );
    }
    for (let index = 0; index < session.tableCount; index += 1) {
      const table = this.#storage.kv.get<DoSqliteTableV1>(this.#keys.table(index));
      const progress = this.#storage.kv.get<TableProgressV1>(this.#keys.tableProgress(index));
      if (table === undefined || progress?.restoredRows !== table.rowCount) {
        restoreError("restore_incomplete", "Logical restore has an incomplete SQLite table");
      }
    }
    const remainingCell = this.#storage.kv
      .list({ prefix: this.#keys.cellPrefix, limit: 1 })[Symbol.iterator]().next();
    if (!remainingCell.done) {
      restoreError("restore_incomplete", "Logical restore has unreferenced SQLite cell parts");
    }

    for (let position = 0; position < session.indexCount; position += 1) {
      const index = this.#storage.kv.get<DoSqliteSchemaBodyV1["indexes"][number]>(
        this.#keys.index(position),
      );
      if (index === undefined) restoreError("restore_incomplete", "SQLite index journal is missing");
      if (session.binding.schemaMode === "empty") this.#storage.sql.exec(index.createSql);
      const created = this.#storage.sql
        .exec<{ type: string; tableName: string }>(
          "SELECT type, tbl_name AS tableName FROM sqlite_schema WHERE name = ?",
          index.name,
        )
        .toArray();
      if (created.length !== 1 || created[0]?.type !== "index" || created[0].tableName !== index.table) {
        restoreError("invalid_archive_record", `SQLite index ${JSON.stringify(index.name)} was not created`);
      }
    }

    const hasSequenceTable = this.#storage.sql
      .exec<{ count: string }>(
        "SELECT CAST(COUNT(*) AS TEXT) AS count FROM sqlite_schema WHERE name = 'sqlite_sequence'",
      )
      .toArray()[0]?.count === "1";
    if (hasSequenceTable) {
      this.#storage.sql.exec("DELETE FROM sqlite_sequence");
      for (let position = 0; position < session.sequenceCount; position += 1) {
        const sequence = this.#storage.kv.get<DoSqliteSchemaBodyV1["sequences"][number]>(
          this.#keys.sequence(position),
        );
        if (sequence === undefined) {
          restoreError("restore_incomplete", "sqlite_sequence journal is missing");
        }
        this.#storage.sql.exec(
          "INSERT INTO sqlite_sequence(name, seq) VALUES (?, CAST(? AS INTEGER))",
          sequence.table,
          sequence.value,
        );
      }
    } else if (session.sequenceCount !== 0) {
      restoreError("invalid_archive_record", "Archive has sqlite_sequence data without AUTOINCREMENT");
    }
  }

  #requireSchema(session: RestoreSessionV2): void {
    if (!session.schemaApplied) {
      restoreError("restore_conflict", "Logical restore data arrived before its schema");
    }
  }

  #session(): RestoreSessionV2 {
    const session = this.#storage.kv.get<RestoreSessionV2>(this.#keys.session);
    if (session === undefined) restoreError("restore_conflict", "Logical restore journal is missing");
    assertSession(session, this.#options);
    return session;
  }
}

function parseFrame(frame: LogicalDoSnapshotFrame, objectId: string): ParsedFrame {
  switch (frame.kind) {
    case "do.descriptor":
      assertMediaType(frame, DO_DESCRIPTOR_MEDIA_TYPE);
      return {
        kind: frame.kind,
        body: decodeDescriptorRecord(parseCanonicalJson(frame.body, { maxBytes: MAX_RECORD_BYTES }), objectId),
      };
    case "do.sqlite.schema":
      assertMediaType(frame, DO_SQLITE_SCHEMA_MEDIA_TYPE);
      return {
        kind: frame.kind,
        body: decodeSchemaRecord(parseCanonicalJson(frame.body, { maxBytes: MAX_RECORD_BYTES })),
      };
    case "do.sqlite.rows":
      assertMediaType(frame, DO_SQLITE_ROWS_MEDIA_TYPE);
      return {
        kind: frame.kind,
        body: decodeRowsRecord(parseCanonicalJson(frame.body, { maxBytes: MAX_RECORD_BYTES })),
      };
    case "do.sqlite.cell":
      assertMediaType(frame, DO_SQLITE_CELL_MEDIA_TYPE);
      if (frame.body.byteLength === 0 || frame.body.byteLength > MAX_CELL_PART_BYTES) {
        restoreError("invalid_archive_record", "SQLite cell part size is invalid");
      }
      return { kind: frame.kind, body: frame.body };
    case "do.kv":
      assertMediaType(frame, DO_KV_MEDIA_TYPE);
      return {
        kind: frame.kind,
        body: decodeKvRecord(parseCanonicalJson(frame.body, { maxBytes: MAX_RECORD_BYTES })),
      };
    default:
      restoreError("invalid_archive_record", `Frame kind ${frame.kind} is not a DO logical record`);
  }
}

function validateFrameEnvelope(frame: LogicalDoSnapshotFrame, objectId: string): void {
  if (frame.objectId !== objectId) {
    restoreError("invalid_archive_record", "Logical restore frame belongs to another object");
  }
  if (!Number.isSafeInteger(frame.part) || frame.part < 0 || frame.part > 0xffff_ffff) {
    restoreError("invalid_archive_record", "Logical restore frame part is invalid");
  }
  if (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity") {
    restoreError("invalid_archive_record", "Logical restore frame encoding is invalid");
  }
  if (!(frame.body instanceof Uint8Array) || frame.body.byteLength > MAX_RECORD_BYTES) {
    restoreError("invalid_archive_record", "Logical restore frame body is invalid");
  }
}

function assertMediaType(frame: LogicalDoSnapshotFrame, expected: string): void {
  if (frame.bodyMediaType !== expected) {
    restoreError("invalid_archive_record", `${frame.kind} frame has the wrong media type`);
  }
}

function verifyCreatedTables(
  storage: LogicalDoStorage,
  expectedTables: readonly DoSqliteTableV1[],
  preservedTables: readonly string[],
): void {
  const actual = inspectPortableSqliteSchema(storage.sql, preservedTables).tables;
  if (actual.length !== expectedTables.length) {
    restoreError("invalid_archive_record", "SQLite schema created an unexpected number of tables");
  }
  const actualByName = new Map(actual.map((table) => [table.name, table]));
  for (const expected of expectedTables) {
    const table = actualByName.get(expected.name);
    if (
      table === undefined ||
      table.withoutRowid !== expected.withoutRowid ||
      JSON.stringify(table.columns) !== JSON.stringify(expected.columns) ||
      JSON.stringify(table.insertColumns) !== JSON.stringify(expected.insertColumns) ||
      JSON.stringify(table.order) !== JSON.stringify(expected.order)
    ) {
      restoreError(
        "invalid_archive_record",
        `SQLite CREATE statement does not match table record ${JSON.stringify(expected.name)}`,
      );
    }
  }
}

function assertRestoreSqlTarget(
  storage: LogicalDoStorage,
  options: ResolvedRestoreOptions,
): void {
  const schema = inspectPortableSqliteSchema(storage.sql, options.preservedSqlTables);
  if (options.schemaMode === "empty") {
    if (schema.tables.length !== 0 || schema.indexes.length !== 0 || schema.sequences.length !== 0) {
      restoreError(
        "restore_target_not_empty",
        "Logical restore target has non-preserved SQLite schema objects",
      );
    }
    return;
  }
  const nonempty = schema.tables.find((table) => table.rowCount !== "0");
  if (nonempty !== undefined || schema.sequences.length !== 0) {
    restoreError(
      "restore_target_not_empty",
      `Fresh-migrated restore target has application data${nonempty ? ` in ${JSON.stringify(nonempty.name)}` : ""}`,
    );
  }
}

function assertMatchingFreshSchema(
  target: DoSqliteSchemaBodyV1,
  archive: DoSqliteSchemaBodyV1,
): void {
  if (target.sequences.length !== 0) {
    restoreError("restore_target_not_empty", "Fresh-migrated target has sqlite_sequence state");
  }
  const targetTables = target.tables.map(({ rowCount: _rowCount, ...table }) => table);
  const archiveTables = archive.tables.map(({ rowCount: _rowCount, ...table }) => table);
  if (
    JSON.stringify(targetTables) !== JSON.stringify(archiveTables) ||
    JSON.stringify(target.indexes) !== JSON.stringify(archive.indexes)
  ) {
    restoreError(
      "restore_conflict",
      "Archive application schema does not exactly match the fresh-migrated target release",
    );
  }
}

function resolveRestoreOptions(options: LogicalDoRestoreOptions): ResolvedRestoreOptions {
  const schemaMode = options.schemaMode ?? "empty";
  if (schemaMode !== "empty" && schemaMode !== "fresh-migrated") {
    throw new TypeError("Logical restore schemaMode is invalid");
  }
  const preservedSqlTables = [...validateExcludedSqlTables(options.preservedSqlTables ?? [])]
    .sort();
  const preservedKvPrefixes = [MANAGED_KV_PREFIX, ...(options.preservedKvPrefixes ?? [])];
  for (const prefix of preservedKvPrefixes) {
    if (
      typeof prefix !== "string" ||
      prefix.length === 0 ||
      RESTORE_JOURNAL_PREFIX.startsWith(prefix) ||
      prefix.startsWith(RESTORE_JOURNAL_PREFIX)
    ) {
      throw new TypeError("Preserved DO KV prefixes must be non-empty and cannot overlap restore journals");
    }
  }
  return {
    ...options,
    schemaMode,
    preservedSqlTables,
    preservedKvPrefixes: [...new Set(preservedKvPrefixes)].sort(),
    transcript: options.transcript === undefined
      ? null
      : resolveRestoreTranscript(options.transcript),
  };
}

function initialSession(options: ResolvedRestoreOptions): RestoreSessionV2 {
  return {
    version: 2,
    binding: restoreBinding(options),
    state: "accepting",
    transcriptVerified: options.transcript === null,
    descriptor: null,
    schemaApplied: false,
    tableCount: 0,
    indexCount: 0,
    sequenceCount: 0,
    restoredRows: "0",
    restoredKvEntries: "0",
    nextParts: {
      tenant: 0,
      "do.descriptor": 0,
      "do.sqlite.schema": 0,
      "do.sqlite.rows": 0,
      "do.sqlite.cell": 0,
      "do.kv": 0,
      "r2.descriptor": 0,
      "r2.body": 0,
      "workers-kv.descriptor": 0,
      "workers-kv.value": 0,
    },
  };
}

function assertSession(session: RestoreSessionV2, options: ResolvedRestoreOptions): void {
  if (
    session?.version !== 2 ||
    (session.state !== "accepting" && session.state !== "database-finalized") ||
    typeof session.transcriptVerified !== "boolean"
  ) {
    restoreError("restore_conflict", "Logical restore journal belongs to another restore");
  }
  assertRestoreBinding(session.binding, options, "journal");
  const mustBeVerified = options.transcript === null || session.state === "database-finalized";
  if (session.transcriptVerified !== mustBeVerified) {
    restoreError("restore_conflict", "Logical restore journal has invalid transcript state");
  }
}

function assertCompletion(completion: CompletionV2, options: ResolvedRestoreOptions): void {
  if (
    completion?.version !== 2 ||
    !Number.isSafeInteger(completion.completedAt) ||
    completion.completedAt < 0
  ) {
    restoreError("restore_conflict", "Logical restore completion marker is invalid");
  }
  assertRestoreBinding(completion.binding, options, "completion marker");
}

function restoreBinding(options: ResolvedRestoreOptions): RestoreBindingV1 {
  return {
    version: 1,
    restoreId: options.restoreId,
    objectId: options.objectId,
    schemaMode: options.schemaMode,
    preservedSqlTables: [...options.preservedSqlTables],
    preservedKvPrefixes: [...options.preservedKvPrefixes],
    transcript: options.transcript === null ? null : { ...options.transcript },
  };
}

function assertRestoreBinding(
  actual: RestoreBindingV1,
  options: ResolvedRestoreOptions,
  label: string,
): void {
  const expected = restoreBinding(options);
  if (
    actual?.version !== 1
    || actual.restoreId !== expected.restoreId
    || actual.objectId !== expected.objectId
    || actual.schemaMode !== expected.schemaMode
    || !equalStrings(actual.preservedSqlTables, expected.preservedSqlTables)
    || !equalStrings(actual.preservedKvPrefixes, expected.preservedKvPrefixes)
    || !sameTranscript(actual.transcript, expected.transcript)
  ) {
    restoreError("restore_conflict", `Logical restore ${label} belongs to another control record`);
  }
}

function resolveRestoreTranscript(transcript: LogicalDoRestoreTranscript): RestoreTranscriptV1 {
  if (
    !transcript
    || typeof transcript !== "object"
    || Array.isArray(transcript)
    || Object.keys(transcript).sort().join(",") !== "bodyBytes,frameCount,semanticSha256"
    || typeof transcript.frameCount !== "string"
    || !UNSIGNED_DECIMAL.test(transcript.frameCount)
    || typeof transcript.bodyBytes !== "string"
    || !UNSIGNED_DECIMAL.test(transcript.bodyBytes)
    || typeof transcript.semanticSha256 !== "string"
    || !SHA256_BASE64URL.test(transcript.semanticSha256)
  ) {
    throw new TypeError("Logical restore transcript is invalid");
  }
  return {
    version: 1,
    frameCount: transcript.frameCount,
    bodyBytes: transcript.bodyBytes,
    semanticSha256: transcript.semanticSha256,
  };
}

function assertTranscriptEvidence(
  expected: RestoreTranscriptV1 | null,
  actual: RestoreTranscriptV1 | undefined,
): void {
  if (expected === null) {
    if (actual !== undefined) {
      restoreError("restore_conflict", "Logical restore did not declare a stream transcript");
    }
    return;
  }
  if (actual === undefined) return;
  if (!sameTranscript(expected, actual)) {
    restoreError("restore_conflict", "Logical restore transcript evidence does not match control");
  }
}

function sameTranscript(
  left: RestoreTranscriptV1 | null | undefined,
  right: RestoreTranscriptV1 | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  return left.version === 1
    && right.version === 1
    && left.frameCount === right.frameCount
    && left.bodyBytes === right.bodyBytes
    && left.semanticSha256 === right.semanticSha256;
}

function equalStrings(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function restoreKeys(restoreId: string) {
  const encoded = encodeBase64Url(textEncoder.encode(restoreId));
  const base = `${RESTORE_JOURNAL_PREFIX}session:${encoded}:`;
  return {
    base,
    complete: `${RESTORE_JOURNAL_PREFIX}complete:${encoded}`,
    session: `${base}state`,
    cellPrefix: `${base}cell:`,
    frame: (kind: string, part: number) => `${base}frame:${kind}:${part}`,
    cell: (part: number) => `${base}cell:${part}`,
    table: (index: number) => `${base}table:${index}`,
    tableProgress: (index: number) => `${base}table-progress:${index}`,
    index: (position: number) => `${base}index:${position}`,
    sequence: (position: number) => `${base}sequence:${position}`,
    kvKey: (digest: string) => `${base}kv-key:${digest}`,
  };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function restoreError(code: ConstructorParameters<typeof NonPortableDoError>[0], message: string): never {
  throw new NonPortableDoError(code, message);
}
