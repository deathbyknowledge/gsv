import { MAX_FRAME_BODY_BYTES } from "./constants";
import { canonicalJsonBytes, parseCanonicalJson } from "./canonical-json";
import { R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";
import {
  cancelOwnedResponse,
  exactFramedBodyStream,
  framedBodyPartCount,
  snapshotFramedBody,
  type FramedBodySource,
} from "./framed-body";
import type { ArchiveDataFrameInput } from "./inner";

export { R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE } from "./features";

export const R2_LOGICAL_SNAPSHOT_FORMAT = "gsv-r2-logical-snapshot" as const;
export const R2_LOGICAL_SNAPSHOT_VERSION = 1 as const;
export const R2_LOGICAL_SNAPSHOT_REQUIRED_SCHEMA_FEATURES = Object.freeze([
  R2_LOGICAL_SNAPSHOT_SCHEMA_FEATURE,
] as const);
export const R2_DESCRIPTOR_MEDIA_TYPE =
  "application/vnd.gsv.r2-descriptor.v1+json" as const;
export const R2_BODY_MEDIA_TYPE = "application/octet-stream" as const;
export const R2_BODY_PART_BYTES = MAX_FRAME_BODY_BYTES;

const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const HTTP_METADATA_KEYS = Object.freeze([
  "cacheControl",
  "cacheExpiry",
  "contentDisposition",
  "contentEncoding",
  "contentLanguage",
  "contentType",
] as const);

export type PortableR2HttpMetadataInput = Readonly<{
  cacheControl?: string;
  cacheExpiry?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
}>;

export type PortableR2HttpMetadataV1 = Readonly<{
  cacheControl: string | null;
  cacheExpiry: string | null;
  contentDisposition: string | null;
  contentEncoding: string | null;
  contentLanguage: string | null;
  contentType: string | null;
}>;

/**
 * Provider-neutral metadata needed to encode one logical R2 object. Provider
 * IDs, ETags, upload/version IDs, timestamps, and encryption credentials do
 * not belong in the portable representation.
 */
export type PortableR2SourceObject = Readonly<{
  key: string;
  size: number;
  storageClass: "Standard" | "InfrequentAccess";
  httpMetadata: PortableR2HttpMetadataInput;
  customMetadata: Readonly<Record<string, string>>;
}>;

export type PortableR2DescriptorV1 = Readonly<{
  format: typeof R2_LOGICAL_SNAPSHOT_FORMAT;
  version: typeof R2_LOGICAL_SNAPSHOT_VERSION;
  record: "object";
  objectId: string;
  key: string;
  size: string;
  bodyParts: string;
  storageClass: "Standard" | "InfrequentAccess";
  encryption: "provider-managed";
  httpMetadata: PortableR2HttpMetadataV1;
  customMetadata: Readonly<Record<string, string>>;
}>;

export type PortableR2FrameSource = FramedBodySource;

export class PortableR2CodecError extends Error {
  constructor(
    readonly code:
      | "body_mismatch"
      | "invalid_descriptor"
      | "unsupported_object",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableR2CodecError";
  }
}

/** Build the canonical metadata record for one provider-managed R2 object. */
export function createPortableR2Descriptor(
  objectId: string,
  object: PortableR2SourceObject,
): PortableR2DescriptorV1 {
  assertObjectId(objectId);
  assertPortableKey(object.key);
  assertLogicalSize(object.size);
  assertStorageClass(object.storageClass);
  const httpMetadata = normalizeHttpMetadata(object.httpMetadata);
  const customMetadata = normalizeCustomMetadata(object.customMetadata);
  return Object.freeze({
    format: R2_LOGICAL_SNAPSHOT_FORMAT,
    version: R2_LOGICAL_SNAPSHOT_VERSION,
    record: "object",
    objectId,
    key: object.key,
    size: object.size.toString(10),
    bodyParts: framedBodyPartCount(object.size).toString(10),
    storageClass: object.storageClass,
    encryption: "provider-managed",
    httpMetadata,
    customMetadata,
  });
}

export function encodePortableR2DescriptorFrame(
  objectId: string,
  object: PortableR2SourceObject,
): ArchiveDataFrameInput {
  const descriptor = createPortableR2Descriptor(objectId, object);
  return Object.freeze({
    kind: "r2.descriptor",
    objectId,
    part: 0,
    bodyMediaType: R2_DESCRIPTOR_MEDIA_TYPE,
    bodyEncoding: "identity",
    body: canonicalJsonBytes(descriptor, { maxBytes: MAX_DESCRIPTOR_BYTES }),
  });
}

export function decodePortableR2DescriptorFrame(
  frame: ArchiveDataFrameInput,
): PortableR2DescriptorV1 {
  if (
    frame.kind !== "r2.descriptor"
    || frame.part !== 0
    || frame.bodyMediaType !== R2_DESCRIPTOR_MEDIA_TYPE
    || (frame.bodyEncoding !== undefined && frame.bodyEncoding !== "identity")
    || !(frame.body instanceof Uint8Array)
    || frame.body.byteLength > MAX_DESCRIPTOR_BYTES
  ) {
    codecError("invalid_descriptor", "R2 descriptor frame envelope is invalid");
  }
  const value = parseCanonicalJson(frame.body, { maxBytes: MAX_DESCRIPTOR_BYTES });
  const record = exactRecord(value, [
    "bodyParts",
    "customMetadata",
    "encryption",
    "format",
    "httpMetadata",
    "key",
    "objectId",
    "record",
    "size",
    "storageClass",
    "version",
  ], "R2 descriptor");
  if (
    record.format !== R2_LOGICAL_SNAPSHOT_FORMAT
    || record.version !== R2_LOGICAL_SNAPSHOT_VERSION
    || record.record !== "object"
    || record.encryption !== "provider-managed"
  ) {
    codecError("invalid_descriptor", "R2 descriptor format is unsupported");
  }
  const objectId = stringValue(record.objectId, "R2 descriptor objectId");
  assertObjectId(objectId);
  if (objectId !== frame.objectId) {
    codecError("invalid_descriptor", "R2 descriptor belongs to another archive object");
  }
  const key = stringValue(record.key, "R2 descriptor key");
  try {
    assertPortableKey(key);
  } catch (cause) {
    throw new PortableR2CodecError(
      "invalid_descriptor",
      "R2 descriptor key is not portable",
      { cause },
    );
  }
  const size = canonicalCount(record.size, "R2 descriptor size");
  assertLogicalSize(size);
  const bodyParts = canonicalCount(record.bodyParts, "R2 descriptor bodyParts");
  if (bodyParts !== framedBodyPartCount(size)) {
    codecError("invalid_descriptor", "R2 descriptor body part count is inconsistent");
  }
  assertStorageClass(record.storageClass);
  const httpMetadata = decodeHttpMetadata(record.httpMetadata);
  const customMetadata = normalizeCustomMetadata(record.customMetadata);
  return Object.freeze({
    format: R2_LOGICAL_SNAPSHOT_FORMAT,
    version: R2_LOGICAL_SNAPSHOT_VERSION,
    record: "object",
    objectId,
    key,
    size: size.toString(10),
    bodyParts: bodyParts.toString(10),
    storageClass: record.storageClass,
    encryption: "provider-managed",
    httpMetadata,
    customMetadata,
  });
}

/**
 * Normalize arbitrary response chunk boundaries into deterministic 4 MiB
 * archive body frames while holding at most one archive part in memory. The
 * generator owns the response body: it consumes it or cancels it.
 */
export async function* snapshotPortableR2Object(input: Readonly<{
  objectId: string;
  object: PortableR2SourceObject;
  response: Response;
}>): AsyncGenerator<ArchiveDataFrameInput> {
  let descriptorFrame: ArchiveDataFrameInput;
  try {
    descriptorFrame = encodePortableR2DescriptorFrame(input.objectId, input.object);
  } catch (error) {
    await cancelOwnedResponse(input.response, error);
    throw error;
  }
  yield* snapshotFramedBody({
    label: "R2 object",
    objectId: input.objectId,
    size: input.object.size,
    bodyKind: "r2.body",
    bodyMediaType: R2_BODY_MEDIA_TYPE,
    descriptorFrame,
    response: input.response,
    fail: (message) => codecError("body_mismatch", message),
  });
}

/** Convert already-validated archive body frames into one exact-length stream. */
export function portableR2BodyStream(
  descriptor: PortableR2DescriptorV1,
  frames: PortableR2FrameSource,
): ReadableStream<Uint8Array> {
  const size = canonicalCount(descriptor.size, "R2 descriptor size");
  const partCount = canonicalCount(descriptor.bodyParts, "R2 descriptor bodyParts");
  return exactFramedBodyStream({
    label: "R2",
    objectId: descriptor.objectId,
    size,
    partCount,
    frames,
    bodyKind: "r2.body",
    bodyMediaType: R2_BODY_MEDIA_TYPE,
    fail: (message) => codecError("body_mismatch", message),
  });
}

function normalizeHttpMetadata(value: PortableR2HttpMetadataInput): PortableR2HttpMetadataV1 {
  if (!isRecord(value)) {
    codecError("invalid_descriptor", "R2 HTTP metadata must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !HTTP_METADATA_KEYS.includes(
    key as (typeof HTTP_METADATA_KEYS)[number],
  ));
  if (unknown.length > 0) {
    codecError("unsupported_object", "R2 HTTP metadata contains an unsupported field");
  }
  const output: Record<(typeof HTTP_METADATA_KEYS)[number], string | null> = {
    cacheControl: null,
    cacheExpiry: null,
    contentDisposition: null,
    contentEncoding: null,
    contentLanguage: null,
    contentType: null,
  };
  for (const key of HTTP_METADATA_KEYS) {
    const child = value[key];
    if (child === undefined || child === null) continue;
    if (typeof child !== "string" || !child || !/^[\x20-\x7e]+$/.test(child)) {
      codecError(
        "unsupported_object",
        `R2 HTTP metadata ${key} cannot round-trip through provider headers`,
      );
    }
    output[key] = key === "cacheExpiry" ? canonicalTimestamp(child) : child;
  }
  return Object.freeze(output) as PortableR2HttpMetadataV1;
}

function decodeHttpMetadata(value: unknown): PortableR2HttpMetadataV1 {
  const record = exactRecord(value, HTTP_METADATA_KEYS, "R2 HTTP metadata");
  const providerShape: Partial<Record<(typeof HTTP_METADATA_KEYS)[number], string>> = {};
  for (const key of HTTP_METADATA_KEYS) {
    const child = record[key];
    if (child === null) continue;
    if (typeof child !== "string") {
      codecError("invalid_descriptor", `R2 HTTP metadata ${key} is invalid`);
    }
    providerShape[key] = child;
  }
  try {
    return normalizeHttpMetadata(providerShape);
  } catch (cause) {
    throw new PortableR2CodecError(
      "invalid_descriptor",
      "R2 HTTP metadata is not portable",
      { cause },
    );
  }
}

function normalizeCustomMetadata(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    codecError("invalid_descriptor", "R2 custom metadata must be an object");
  }
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, child] of Object.entries(value)) {
    if (
      key.length > 128
      || key !== key.toLowerCase()
      || !/^[a-z0-9!#$&'*+.^_`|~-]+$/.test(key)
    ) {
      codecError(
        "unsupported_object",
        "R2 custom metadata keys must be lowercase ASCII HTTP tokens",
      );
    }
    if (typeof child !== "string" || /[\u0000-\u001f\u007f]/u.test(child)) {
      codecError(
        "unsupported_object",
        "R2 custom metadata values must be strings without controls",
      );
    }
    output[key] = child;
  }
  return Object.freeze(output);
}

function canonicalTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) {
    codecError("unsupported_object", "R2 cache expiry is invalid");
  }
  const canonical = timestamp.toISOString();
  if (timestamp.getUTCMilliseconds() !== 0) {
    codecError("unsupported_object", "R2 cache expiry has sub-second precision");
  }
  return canonical;
}

function assertPortableKey(value: string): void {
  if (
    !value
    || !value.isWellFormed()
    || new TextEncoder().encode(value).byteLength > 1_024
    || /\p{Cc}/u.test(value)
  ) {
    codecError("unsupported_object", "R2 object key is not portable");
  }
}

function assertLogicalSize(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    codecError("unsupported_object", "R2 object size is not portable");
  }
}

function assertObjectId(value: string): void {
  if (
    !value
    || !value.isWellFormed()
    || new TextEncoder().encode(value).byteLength > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    codecError("invalid_descriptor", "R2 archive objectId is invalid");
  }
}

function assertStorageClass(
  value: unknown,
): asserts value is "Standard" | "InfrequentAccess" {
  if (value !== "Standard" && value !== "InfrequentAccess") {
    codecError("unsupported_object", "R2 storage class is unsupported");
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
  if (!isRecord(value)) codecError("invalid_descriptor", `${label} must be an object`);
  assertOnlyKeys(value, keys, label);
  return value;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    codecError("invalid_descriptor", `${label} has unexpected or missing fields`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") codecError("invalid_descriptor", `${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codecError(
  code: PortableR2CodecError["code"],
  message: string,
): never {
  throw new PortableR2CodecError(code, message);
}
