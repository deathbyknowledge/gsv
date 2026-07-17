import type {
  ManagedObjectRestoreControl,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import {
  restoreLogicalDurableObjectStream,
  snapshotLogicalDurableObjectStream,
  type LogicalDoStreamRestoreResult,
} from "@humansandmachines/gsv-worker-runtime/portable-do";

export const MANAGED_RESTORE_TARGET_KEY = "__gsv:managed:restore-target";
export const GSV_SCHEMA_MIGRATIONS_TABLE = "_gsv_schema_migrations";

const RESTORE_JOURNAL_PREFIX = "__gsv:restore:";
const MANAGED_PREFIX = "__gsv:managed:";
const PLATFORM_TABLES = new Set(["__cf_kv", "_cf_KV", "_cf_METADATA"]);

type ManagedRestoreTarget = Readonly<{
  version: 1;
  restoreId: string;
  objectId: string;
  logicalName: string;
}>;

export type ManagedOwnerSnapshotInput = Readonly<{
  objectId: string;
  assertFenced(): void;
}>;

/** Shared owner policy for GSV SQLite-backed Durable Objects. */
export function snapshotManagedOwner(
  storage: DurableObjectStorage,
  input: ManagedOwnerSnapshotInput,
): ReadableStream<Uint8Array> {
  return snapshotLogicalDurableObjectStream(storage, {
    objectId: input.objectId,
    fence: { assertFenced: input.assertFenced },
    excludedSqlTables: [GSV_SCHEMA_MIGRATIONS_TABLE],
  });
}

export async function restoreManagedOwner(
  storage: DurableObjectStorage,
  stream: ReadableStream<Uint8Array>,
  control: ManagedObjectRestoreControl,
  assertFenced: () => void,
): Promise<LogicalDoStreamRestoreResult> {
  assertRestoreTarget(storage, control);
  return restoreLogicalDurableObjectStream(storage, stream, {
    restoreId: control.restoreId,
    objectId: control.objectId,
    fence: { assertFenced },
    schemaMode: "fresh-migrated",
    preservedSqlTables: [GSV_SCHEMA_MIGRATIONS_TABLE],
    frameCount: control.frameCount,
    bodyBytes: control.bodyBytes,
    semanticSha256: control.semanticSha256,
  });
}

export function readManagedRestoreTarget(
  storage: DurableObjectStorage,
): ManagedRestoreTarget | null {
  const value = storage.kv.get<unknown>(MANAGED_RESTORE_TARGET_KEY);
  if (value === undefined) return null;
  return parseRestoreTarget(value);
}

/**
 * Converts constructor-created baseline rows into the empty application data
 * required by a fresh-migrated restore, once, after the owning object has
 * proved that it is an uninitialized destination. Managed fence state and the
 * migration ledger are provider-local and intentionally preserved.
 */
export async function prepareManagedRestoreTarget(
  storage: DurableObjectStorage,
  control: ManagedObjectRestoreControl,
): Promise<"prepared" | "replayed"> {
  const expected = restoreTargetFromControl(control);
  const existing = readManagedRestoreTarget(storage);
  if (existing) {
    assertSameRestoreTarget(existing, expected);
    return "replayed";
  }
  if (await storage.getAlarm() !== null) {
    throw new Error("Managed restore target has an application alarm");
  }

  storage.transactionSync(() => {
    const raced = readManagedRestoreTarget(storage);
    if (raced) {
      assertSameRestoreTarget(raced, expected);
      return;
    }
    const restoreJournal = storage.kv
      .list({ prefix: RESTORE_JOURNAL_PREFIX, limit: 1 })[Symbol.iterator]().next();
    if (!restoreJournal.done) {
      throw new Error("Managed restore target has an unrelated restore journal");
    }

    const tables = storage.sql.exec<{ name: string }>(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table'
       ORDER BY name`,
    ).toArray();
    for (const { name } of tables) {
      if (
        name === GSV_SCHEMA_MIGRATIONS_TABLE
        || name === "sqlite_sequence"
        || name.startsWith("sqlite_")
        || PLATFORM_TABLES.has(name)
      ) {
        continue;
      }
      storage.sql.exec(`DELETE FROM ${quoteIdentifier(name)}`);
    }
    if (tables.some(({ name }) => name === "sqlite_sequence")) {
      storage.sql.exec("DELETE FROM sqlite_sequence");
    }

    const applicationKeys = [...storage.kv.list()]
      .map(([key]) => key)
      .filter((key) => !key.startsWith(MANAGED_PREFIX));
    for (const key of applicationKeys) storage.kv.delete(key);
    storage.kv.put(MANAGED_RESTORE_TARGET_KEY, expected);
  });
  return "prepared";
}

export function assertRestoreTarget(
  storage: DurableObjectStorage,
  control: ManagedObjectRestoreControl,
): void {
  const existing = readManagedRestoreTarget(storage);
  if (!existing) throw new Error("Managed restore target was not prepared");
  assertSameRestoreTarget(existing, restoreTargetFromControl(control));
}

function restoreTargetFromControl(
  control: ManagedObjectRestoreControl,
): ManagedRestoreTarget {
  return Object.freeze({
    version: 1,
    restoreId: control.restoreId,
    objectId: control.objectId,
    logicalName: control.logicalName,
  });
}

function parseRestoreTarget(value: unknown): ManagedRestoreTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed restore target marker is invalid");
  }
  const candidate = value as Partial<ManagedRestoreTarget>;
  if (
    candidate.version !== 1
    || typeof candidate.restoreId !== "string"
    || typeof candidate.objectId !== "string"
    || typeof candidate.logicalName !== "string"
  ) {
    throw new Error("Managed restore target marker is invalid");
  }
  return candidate as ManagedRestoreTarget;
}

function assertSameRestoreTarget(
  actual: ManagedRestoreTarget,
  expected: ManagedRestoreTarget,
): void {
  if (
    actual.version !== expected.version
    || actual.restoreId !== expected.restoreId
    || actual.objectId !== expected.objectId
    || actual.logicalName !== expected.logicalName
  ) {
    throw new Error("Managed restore target belongs to another restore");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
