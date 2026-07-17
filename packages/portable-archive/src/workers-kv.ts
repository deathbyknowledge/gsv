import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "./canonical-json";
import { MAX_FRAME_BODY_BYTES } from "./constants";
import { WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";
import {
  cancelOwnedResponse,
  exactFramedBodyStream,
  framedBodyPartCount,
  snapshotFramedBody,
  type FramedBodySource,
} from "./framed-body";
import type { ArchiveDataFrameInput } from "./inner";

export { WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";

export const WORKERS_KV_LOGICAL_SNAPSHOT_FORMAT =
  "gsv-workers-kv-logical-snapshot" as const;
export const WORKERS_KV_LOGICAL_SNAPSHOT_VERSION = 1 as const;
export const WORKERS_KV_LOGICAL_SNAPSHOT_REQUIRED_SCHEMA_FEATURES = Object.freeze([
  WORKERS_KV_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
] as const);
export const WORKERS_KV_DESCRIPTOR_MEDIA_TYPE =
  "application/vnd.gsv.workers-kv-descriptor.v1+json" as const;
export const WORKERS_KV_VALUE_MEDIA_TYPE = "application/octet-stream" as const;
export const WORKERS_KV_VALUE_PART_BYTES = MAX_FRAME_BODY_BYTES;

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 48 * 1024;

/** Provider-neutral metadata needed to archive one logical Workers KV entry. */
export type PortableWorkersKvSourceEntry = Readonly<{
  key: string;
  valueBytes: number;
  expiration: number | null;
  metadata: unknown;
}>;

export type PortableWorkersKvDescriptorV1 = Readonly<{
  format: typeof WORKERS_KV_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof WORKERS_KV_LOGICAL_SNAPSHOT_VERSION;
  record: "entry";
  objectId: string;
  key: string;
  valueBytes: string;
  valueParts: string;
  expiration: string | null;
  metadata: CanonicalJsonValue;
}>;

export type PortableWorkersKvFrameSource = FramedBodySource;

export class PortableWorkersKvCodecError extends Error {
  constructor(
    readonly code:
      | "body_mismatch"
      | "invalid_descriptor"
      | "unsupported_entry",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableWorkersKvCodecError";
  }
}

/** Build the canonical descriptor for one Workers KV key/value entry. */
export function createPortableWorkersKvDescriptor(
  objectId: string,
  entry: PortableWorkersKvSourceEntry,
): PortableWorkersKvDescriptorV1 {
  assertObjectId(objectId);
  assertPortableKey(entry.key, "unsupported_entry");
  assertLogicalSize(entry.valueBytes, "unsupported_entry");
  assertExpiration(entry.expiration, "unsupported_entry");
  const metadata = normalizeMetadata(entry.metadata, "unsupported_entry");
  return Object.freeze({
    format: WORKERS_KV_LOGICAL_SNAPSHOT_FORMAT,
    version: WORKERS_KV_LOGICAL_SNAPSHOT_VERSION,
    record: "entry",
    objectId,
    key: entry.key,
    valueBytes: entry.valueBytes.toString(10),
    valueParts: framedBodyPartCount(entry.valueBytes).toString(10),
    expiration: entry.expiration === null ? null : entry.expiration.toString(10),
    metadata,
  });
}

export function encodePortableWorkersKvDescriptorFrame(
  objectId: string,
  entry: PortableWorkersKvSourceEntry,
): ArchiveDataFrameInput {
  const descriptor = createPortableWorkersKvDescriptor(objectId, entry);
  let body: Uint8Array;
  try {
    body = canonicalJsonBytes(descriptor, { maxBytes: MAX_DESCRIPTOR_BYTES });
  } catch (cause) {
    throw new PortableWorkersKvCodecError(
      "unsupported_entry",
      "Workers KV descriptor exceeds the portable format limit",
      { cause },
    );
  }
  return Object.freeze({
    kind: "workers-kv.descriptor",
    objectId,
    part: 0,
    bodyMediaType: WORKERS_KV_DESCRIPTOR_MEDIA_TYPE,
    bodyEncoding: "identity",
    body,
  });
}

export function decodePortableWorkersKvDescriptorFrame(
  frame: ArchiveDataFrameInput,
): PortableWorkersKvDescriptorV1 {
  if (
    frame.kind !== "workers-kv.descriptor"
    || frame.part !== 0
    || frame.bodyMediaType !== WORKERS_KV_DESCRIPTOR_MEDIA_TYPE
    || (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity")
    || !(frame.body instanceof Uint8Array)
    || frame.body.byteLength > MAX_DESCRIPTOR_BYTES
  ) {
    codecError("invalid_descriptor", "Workers KV descriptor frame envelope is invalid");
  }
  const value = parseCanonicalJson(frame.body, { maxBytes: MAX_DESCRIPTOR_BYTES });
  const record = exactRecord(value, [
    "expiration",
    "format",
    "key",
    "metadata",
    "objectId",
    "record",
    "valueBytes",
    "valueParts",
    "version",
  ], "Workers KV descriptor");
  if (
    record.format !== WORKERS_KV_LOGICAL_SNAPSHOT_FORMAT
    || record.version !== WORKERS_KV_LOGICAL_SNAPSHOT_VERSION
    || record.record !== "entry"
  ) {
    codecError("invalid_descriptor", "Workers KV descriptor format is unsupported");
  }
  const objectId = stringValue(record.objectId, "Workers KV descriptor objectId");
  assertObjectId(objectId);
  if (objectId !== frame.objectId) {
    codecError(
      "invalid_descriptor",
      "Workers KV descriptor belongs to another archive object",
    );
  }
  const key = stringValue(record.key, "Workers KV descriptor key");
  assertPortableKey(key, "invalid_descriptor");
  const valueBytes = canonicalCount(record.valueBytes, "Workers KV valueBytes");
  assertLogicalSize(valueBytes, "invalid_descriptor");
  const valueParts = canonicalCount(record.valueParts, "Workers KV valueParts");
  if (valueParts !== framedBodyPartCount(valueBytes)) {
    codecError(
      "invalid_descriptor",
      "Workers KV descriptor value part count is inconsistent",
    );
  }
  const expiration = record.expiration === null
    ? null
    : canonicalCount(record.expiration, "Workers KV expiration");
  assertExpiration(expiration, "invalid_descriptor");
  const metadata = normalizeMetadata(record.metadata, "invalid_descriptor");
  return Object.freeze({
    format: WORKERS_KV_LOGICAL_SNAPSHOT_FORMAT,
    version: WORKERS_KV_LOGICAL_SNAPSHOT_VERSION,
    record: "entry",
    objectId,
    key,
    valueBytes: valueBytes.toString(10),
    valueParts: valueParts.toString(10),
    expiration: expiration === null ? null : expiration.toString(10),
    metadata,
  });
}

/**
 * Normalize arbitrary response chunks into deterministic 4 MiB value frames.
 * The generator consumes or cancels the source response on every path.
 */
export async function* snapshotPortableWorkersKvEntry(input: Readonly<{
  objectId: string;
  entry: PortableWorkersKvSourceEntry;
  response: Response;
}>): AsyncGenerator<ArchiveDataFrameInput> {
  let descriptorFrame: ArchiveDataFrameInput;
  try {
    descriptorFrame = encodePortableWorkersKvDescriptorFrame(input.objectId, input.entry);
  } catch (error) {
    await cancelOwnedResponse(input.response, error);
    throw error;
  }
  yield* snapshotFramedBody({
    label: "Workers KV value",
    objectId: input.objectId,
    size: input.entry.valueBytes,
    bodyKind: "workers-kv.value",
    bodyMediaType: WORKERS_KV_VALUE_MEDIA_TYPE,
    descriptorFrame,
    response: input.response,
    fail: (message) => codecError("body_mismatch", message),
  });
}

/** Convert validated value frames into one exact-length restore stream. */
export function portableWorkersKvValueStream(
  descriptor: PortableWorkersKvDescriptorV1,
  frames: PortableWorkersKvFrameSource,
): ReadableStream<Uint8Array> {
  const valueBytes = canonicalCount(descriptor.valueBytes, "Workers KV valueBytes");
  const valueParts = canonicalCount(descriptor.valueParts, "Workers KV valueParts");
  return exactFramedBodyStream({
    label: "Workers KV",
    objectId: descriptor.objectId,
    size: valueBytes,
    partCount: valueParts,
    frames,
    bodyKind: "workers-kv.value",
    bodyMediaType: WORKERS_KV_VALUE_MEDIA_TYPE,
    fail: (message) => codecError("body_mismatch", message),
  });
}

function normalizeMetadata(
  value: unknown,
  code: "invalid_descriptor" | "unsupported_entry",
): CanonicalJsonValue {
  try {
    const canonical = canonicalJsonBytes(value, {
      maxBytes: MAX_METADATA_BYTES,
      maxDepth: 64,
    });
    return freezeJson(parseCanonicalJson(canonical, {
      maxBytes: MAX_METADATA_BYTES,
      maxDepth: 64,
    }));
  } catch (cause) {
    throw new PortableWorkersKvCodecError(
      code,
      code === "invalid_descriptor"
        ? "Workers KV descriptor metadata is not canonical JSON"
        : "Workers KV metadata is not portable canonical JSON",
      { cause },
    );
  }
}

function freezeJson(value: CanonicalJsonValue): CanonicalJsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function assertPortableKey(
  value: string,
  code: "invalid_descriptor" | "unsupported_entry",
): void {
  if (
    typeof value !== "string"
    || !value
    || !value.isWellFormed()
    || new TextEncoder().encode(value).byteLength > 1_024
    || /\p{Cc}/u.test(value)
  ) {
    codecError(code, "Workers KV key is not portable");
  }
}

function assertLogicalSize(
  value: unknown,
  code: "invalid_descriptor" | "unsupported_entry",
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    codecError(code, "Workers KV value size is not portable");
  }
}

function assertExpiration(
  value: unknown,
  code: "invalid_descriptor" | "unsupported_entry",
): asserts value is number | null {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 1)) {
    codecError(code, "Workers KV expiration is not a positive whole Unix second");
  }
}

function assertObjectId(value: string): void {
  if (
    typeof value !== "string"
    || !value
    || !value.isWellFormed()
    || new TextEncoder().encode(value).byteLength > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    codecError("invalid_descriptor", "Workers KV archive objectId is invalid");
  }
}

function canonicalCount(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    codecError("invalid_descriptor", `${label} is not a canonical count`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    codecError("invalid_descriptor", `${label} exceeds JavaScript precision`);
  }
  return count;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    codecError("invalid_descriptor", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    codecError("invalid_descriptor", `${label} has unexpected or missing fields`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    codecError("invalid_descriptor", `${label} must be a string`);
  }
  return value;
}

function codecError(
  code: PortableWorkersKvCodecError["code"],
  message: string,
): never {
  throw new PortableWorkersKvCodecError(code, message);
}
