import { decodeBase64Url } from "./bytes";
import {
  NORMALIZATION_POLICY_VERSION,
  PORTABLE_ARCHIVE_VERSION,
  SHA256_BYTES,
} from "./constants";
import { assertValidUnicode } from "./canonical-json";
import { fail } from "./error";

export const PORTABLE_ARCHIVE_FORMAT = "gsv-portable-archive" as const;

export type ArchiveDeploymentKind = "managed" | "self-hosted";
export type ArchiveInventoryKind =
  | "tenant"
  | "durable-object"
  | "r2-object"
  | "ripgit-repository"
  | "workers-kv-entry";

export type ArchiveSqliteTableV1 = Readonly<{
  name: string;
  rowCount: string;
}>;

export type ArchiveSqliteInventoryV1 = Readonly<{
  tables: readonly ArchiveSqliteTableV1[];
}>;

export type ArchiveKeyValueInventoryV1 = Readonly<{
  entryCount: string;
}>;

export type ArchiveObjectStorageV1 = Readonly<{
  sqlite?: ArchiveSqliteInventoryV1;
  durableObjectKv?: ArchiveKeyValueInventoryV1;
  r2?: Readonly<{
    objectCount: string;
    totalBytes: string;
  }>;
  workersKv?: Readonly<{
    entryCount: string;
    totalBytes: string;
  }>;
}>;

export type ArchiveInventoryObjectV1 = Readonly<{
  objectId: string;
  kind: ArchiveInventoryKind;
  component: string;
  logicalName: string;
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
  storage: ArchiveObjectStorageV1;
}>;

export type ArchiveManifestTotalsV1 = Readonly<{
  dataFrames: string;
  dataBodyBytes: string;
  r2Objects: string;
  r2Bytes: string;
}>;

export type ArchiveManifestV1 = Readonly<{
  format: typeof PORTABLE_ARCHIVE_FORMAT;
  version: typeof PORTABLE_ARCHIVE_VERSION;
  archiveId: string;
  createdAt: string;
  source: Readonly<{
    release: string;
    deployment: ArchiveDeploymentKind;
  }>;
  consistency: Readonly<{
    mode: "quiesced";
    frozenAt: string;
  }>;
  normalizationPolicyVersion: typeof NORMALIZATION_POLICY_VERSION;
  requiredSchemaFeatures: readonly string[];
  inventory: readonly ArchiveInventoryObjectV1[];
  totals: ArchiveManifestTotalsV1;
}>;

export function assertArchiveManifest(value: unknown): asserts value is ArchiveManifestV1 {
  const manifest = expectRecord(value, "archive manifest");
  expectExactKeys(
    manifest,
    [
      "format",
      "version",
      "archiveId",
      "createdAt",
      "source",
      "consistency",
      "normalizationPolicyVersion",
      "requiredSchemaFeatures",
      "inventory",
      "totals",
    ],
    "archive manifest",
  );
  if (manifest.format !== PORTABLE_ARCHIVE_FORMAT || manifest.version !== 1) {
    fail("invalid_manifest", "archive manifest has an unsupported format version");
  }
  assertIdentifier(manifest.archiveId, "archiveId", 256);
  assertTimestamp(manifest.createdAt, "createdAt");

  const source = expectRecord(manifest.source, "archive source");
  expectExactKeys(source, ["release", "deployment"], "archive source");
  assertIdentifier(source.release, "source release", 512);
  if (source.deployment !== "managed" && source.deployment !== "self-hosted") {
    fail("invalid_manifest", "source deployment must be managed or self-hosted");
  }

  const consistency = expectRecord(manifest.consistency, "archive consistency");
  expectExactKeys(consistency, ["mode", "frozenAt"], "archive consistency");
  if (consistency.mode !== "quiesced") {
    fail("invalid_manifest", "v1 archives require a quiesced snapshot");
  }
  assertTimestamp(consistency.frozenAt, "frozenAt");
  if (consistency.frozenAt !== manifest.createdAt) {
    fail("invalid_manifest", "createdAt must equal the quiesced snapshot time in v1");
  }
  if (manifest.normalizationPolicyVersion !== NORMALIZATION_POLICY_VERSION) {
    fail("invalid_manifest", "archive uses an unsupported normalization policy");
  }

  const features = expectStringArray(
    manifest.requiredSchemaFeatures,
    "requiredSchemaFeatures",
  );
  assertSortedUnique(features, "requiredSchemaFeatures");
  features.forEach((feature) => assertIdentifier(feature, "schema feature", 128));

  assertArchiveInventory(manifest.inventory, manifest.totals);
}

/** Validate the independently reusable inventory/totals portion of a manifest. */
export function assertArchiveInventory(inventory: unknown, rawTotals: unknown): void {
  if (!Array.isArray(inventory)) {
    fail("invalid_manifest", "archive inventory must be an array");
  }
  let previousObjectId: string | undefined;
  let countedFrames = 0n;
  let countedBodyBytes = 0n;
  let countedR2Objects = 0n;
  let countedR2Bytes = 0n;
  for (const rawObject of inventory) {
    const item = expectRecord(rawObject, "inventory object");
    expectExactKeys(
      item,
      [
        "objectId",
        "kind",
        "component",
        "logicalName",
        "frameCount",
        "bodyBytes",
        "semanticSha256",
        "storage",
      ],
      "inventory object",
    );
    const objectId = assertIdentifier(item.objectId, "inventory objectId", 1024);
    if (previousObjectId !== undefined && previousObjectId >= objectId) {
      fail("invalid_manifest", "archive inventory must be sorted by unique objectId");
    }
    previousObjectId = objectId;
    if (!INVENTORY_KINDS.has(item.kind as ArchiveInventoryKind)) {
      fail("invalid_manifest", "inventory object has an unknown kind");
    }
    const kind = item.kind as ArchiveInventoryKind;
    assertIdentifier(item.component, "inventory component", 128);
    assertIdentifier(item.logicalName, "inventory logicalName", 1024);
    countedFrames += parseCount(item.frameCount, "inventory frameCount");
    countedBodyBytes += parseCount(item.bodyBytes, "inventory bodyBytes");
    assertSha256(item.semanticSha256, "inventory semanticSha256");

    const storage = expectRecord(item.storage, "inventory storage");
    const storageKeys = Object.keys(storage).sort();
    if (
      storageKeys.some(
        (key) =>
          key !== "durableObjectKv" &&
          key !== "r2" &&
          key !== "sqlite" &&
          key !== "workersKv",
      )
    ) {
      fail("invalid_manifest", "inventory storage has an unknown field");
    }
    if (storage.sqlite !== undefined) validateSqliteInventory(storage.sqlite);
    if (storage.durableObjectKv !== undefined) {
      validateKeyValueInventory(storage.durableObjectKv, "Durable Object KV");
    }
    if (storage.workersKv !== undefined) {
      const workersKv = expectRecord(storage.workersKv, "Workers KV inventory");
      expectExactKeys(
        workersKv,
        ["entryCount", "totalBytes"],
        "Workers KV inventory",
      );
      const entryCount = parseCount(workersKv.entryCount, "Workers KV entryCount");
      parseCount(workersKv.totalBytes, "Workers KV totalBytes");
      if (kind !== "workers-kv-entry" || entryCount !== 1n) {
        fail(
          "invalid_manifest",
          "Workers KV storage must describe exactly one workers-kv-entry",
        );
      }
    }
    if (storage.r2 !== undefined) {
      const r2 = expectRecord(storage.r2, "R2 inventory");
      expectExactKeys(
        r2,
        ["objectCount", "totalBytes"],
        "R2 inventory",
      );
      const objectCount = parseCount(r2.objectCount, "R2 objectCount");
      if (kind !== "r2-object" || objectCount !== 1n) {
        fail(
          "invalid_manifest",
          "R2 storage must describe exactly one r2-object",
        );
      }
      countedR2Objects += objectCount;
      countedR2Bytes += parseCount(r2.totalBytes, "R2 totalBytes");
    }
    if (kind === "r2-object" && storage.r2 === undefined) {
      fail("invalid_manifest", "r2-object inventory requires R2 storage detail");
    }
    if (
      kind === "r2-object"
      && (storageKeys.length !== 1 || storageKeys[0] !== "r2")
    ) {
      fail("invalid_manifest", "r2-object inventory has unrelated storage detail");
    }
    if (kind === "workers-kv-entry" && storage.workersKv === undefined) {
      fail(
        "invalid_manifest",
        "workers-kv-entry inventory requires Workers KV storage detail",
      );
    }
    if (
      kind === "workers-kv-entry"
      && (storageKeys.length !== 1 || storageKeys[0] !== "workersKv")
    ) {
      fail(
        "invalid_manifest",
        "workers-kv-entry inventory has unrelated storage detail",
      );
    }
  }

  const totals = expectRecord(rawTotals, "archive totals");
  expectExactKeys(
    totals,
    ["dataFrames", "dataBodyBytes", "r2Objects", "r2Bytes"],
    "archive totals",
  );
  assertEqualCount(totals.dataFrames, countedFrames, "dataFrames");
  assertEqualCount(totals.dataBodyBytes, countedBodyBytes, "dataBodyBytes");
  assertEqualCount(totals.r2Objects, countedR2Objects, "r2Objects");
  assertEqualCount(totals.r2Bytes, countedR2Bytes, "r2Bytes");
}

export function createArchiveManifest(
  value: ArchiveManifestV1,
): ArchiveManifestV1 {
  assertArchiveManifest(value);
  return value;
}

function validateSqliteInventory(value: unknown): void {
  const sqlite = expectRecord(value, "SQLite inventory");
  expectExactKeys(sqlite, ["tables"], "SQLite inventory");
  if (!Array.isArray(sqlite.tables)) {
    fail("invalid_manifest", "SQLite tables must be an array");
  }
  let previousName: string | undefined;
  for (const rawTable of sqlite.tables) {
    const table = expectRecord(rawTable, "SQLite table inventory");
    expectExactKeys(
      table,
      ["name", "rowCount"],
      "SQLite table inventory",
    );
    const name = assertIdentifier(table.name, "SQLite table name", 1024);
    if (previousName !== undefined && previousName >= name) {
      fail("invalid_manifest", "SQLite tables must be sorted by unique name");
    }
    previousName = name;
    parseCount(table.rowCount, "SQLite rowCount");
  }
}

function validateKeyValueInventory(value: unknown, label: string): void {
  const inventory = expectRecord(value, `${label} inventory`);
  expectExactKeys(inventory, ["entryCount"], `${label} inventory`);
  parseCount(inventory.entryCount, `${label} entryCount`);
}

function assertEqualCount(value: unknown, expected: bigint, label: string): void {
  if (parseCount(value, label) !== expected) {
    fail("invalid_manifest", `${label} does not match the inventory sum`);
  }
}

function parseCount(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_manifest", `${label} must be a canonical unsigned decimal`);
  }
  const count = BigInt(value);
  if (count > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_manifest", `${label} exceeds the v1 unsigned 64-bit range`);
  }
  return count;
}

function assertSha256(value: unknown, label: string): void {
  if (typeof value !== "string") fail("invalid_manifest", `${label} must be a string`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch (error) {
    fail("invalid_manifest", `${label} is not canonical base64url: ${String(error)}`);
  }
  if (bytes.byteLength !== SHA256_BYTES) {
    fail("invalid_manifest", `${label} must contain a SHA-256 digest`);
  }
}

function assertTimestamp(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("invalid_manifest", `${label} must be a canonical UTC timestamp`);
  }
}

function assertIdentifier(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_manifest", `${label} must be a non-empty string`);
  }
  assertValidUnicode(value);
  if (new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("invalid_manifest", `${label} contains control data or exceeds its byte limit`);
  }
  return value;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      fail("invalid_manifest", `${label} must be sorted and unique`);
    }
  }
}

function expectStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail("invalid_manifest", `${label} must be an array of strings`);
  }
  return value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("invalid_manifest", `${label} has unexpected or missing fields`);
  }
}

const INVENTORY_KINDS = new Set<ArchiveInventoryKind>([
  "tenant",
  "durable-object",
  "r2-object",
  "ripgit-repository",
  "workers-kv-entry",
]);
