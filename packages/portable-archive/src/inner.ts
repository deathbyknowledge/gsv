import {
  ByteReader,
  type ByteSource,
  collectBytes,
  concatBytes,
  decodeBase64Url,
  decodeU32,
  decodeU64,
  encodeBase64Url,
  encodeU32,
  encodeU64,
  equalBytes,
} from "./bytes";
import { canonicalJsonBytes, parseCanonicalJson } from "./canonical-json";
import {
  DEFAULT_MAX_FRAME_HEADER_BYTES,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_TOTAL_BODY_BYTES,
  INNER_MAGIC,
  MAX_FRAME_BODY_BYTES,
  SHA256_BYTES,
  TRAILER_MAGIC,
  ZERO_SHA256,
} from "./constants";
import { type PortableCrypto, sha256Parts } from "./crypto";
import { fail } from "./error";
import {
  type ArchiveManifestV1,
  assertArchiveManifest,
} from "./manifest";
import { ObjectSemanticDigestV1 } from "./semantic";
import { ContiguousObjectRunTracker } from "./object-run";

export const MANIFEST_MEDIA_TYPE =
  "application/vnd.gsv.portable-manifest+json" as const;

export type ArchiveFrameKind =
  | "tenant"
  | "do.descriptor"
  | "do.sqlite.schema"
  | "do.sqlite.rows"
  | "do.sqlite.cell"
  | "do.kv"
  | "r2.descriptor"
  | "r2.body"
  | "workers-kv.descriptor"
  | "workers-kv.value"
  | "manifest";

export type ArchiveDataFrameKind = Exclude<ArchiveFrameKind, "manifest">;

export type ArchiveFrameHeaderV1 = Readonly<{
  sequence: string;
  kind: ArchiveFrameKind;
  objectId: string;
  part: number;
  bodyMediaType: string;
  bodyEncoding: "identity";
  bodySha256: string;
  previousFrameDigest: string;
}>;

export type ArchiveDataFrameInput = Readonly<{
  kind: ArchiveDataFrameKind;
  objectId: string;
  part: number;
  bodyMediaType: string;
  bodyEncoding?: "identity";
  body: Uint8Array;
}>;

export type DecodedArchiveFrame = Readonly<{
  offset: bigint;
  header: ArchiveFrameHeaderV1;
  headerBytes: Uint8Array;
  body: Uint8Array;
  digest: Uint8Array;
}>;

export type InnerArchiveLimits = Readonly<{
  maxHeaderBytes?: number;
  maxBodyBytes?: number;
  maxFrames?: number;
  maxTotalBodyBytes?: bigint;
}>;

export type InnerArchiveValidationOptions = InnerArchiveLimits &
  Readonly<{
    crypto?: PortableCrypto;
    onFrame?: (frame: DecodedArchiveFrame) => void | Promise<void>;
  }>;

export type InnerArchiveValidationResult = Readonly<{
  manifest: ArchiveManifestV1;
  manifestOffset: bigint;
  dataFrameCount: number;
  frameCount: number;
  dataBodyBytes: bigint;
  totalBodyBytes: bigint;
  finalFrameDigest: Uint8Array;
}>;

/**
 * A deferred manifest lets a one-pass exporter compute per-object semantic
 * digests while frames are already flowing to the encrypted output stream.
 */
export type ArchiveManifestSource =
  | ArchiveManifestV1
  | PromiseLike<ArchiveManifestV1>;

type ObservedObject = {
  frames: bigint;
  bodyBytes: bigint;
  semantic: ObjectSemanticDigestV1;
};

export async function* encodeInnerArchiveStream(
  frames: Iterable<ArchiveDataFrameInput> | AsyncIterable<ArchiveDataFrameInput>,
  manifest: ArchiveManifestSource,
  options: InnerArchiveLimits & Readonly<{ crypto?: PortableCrypto }> = {},
): AsyncGenerator<Uint8Array> {
  const limits = resolveLimits(options);
  yield INNER_MAGIC;
  let offset = BigInt(INNER_MAGIC.byteLength);
  let previousDigest: Uint8Array = ZERO_SHA256;
  let sequence = 0;
  let totalBodyBytes = 0n;
  const observed = new Map<string, ObservedObject>();
  const objectRuns = new ContiguousObjectRunTracker();

  for await (const input of frames) {
    if (sequence >= limits.maxFrames - 1) {
      fail("limit_exceeded", "inner archive exceeds its frame limit");
    }
    validateDataFrameInput(input, limits.maxBodyBytes);
    objectRuns.observe(input.objectId, (message) => fail("invalid_frame", message));
    totalBodyBytes += BigInt(input.body.byteLength);
    if (totalBodyBytes > limits.maxTotalBodyBytes) {
      fail("limit_exceeded", "inner archive exceeds its total body byte limit");
    }
    const encoded = await encodeFrame(
      {
        sequence: sequence.toString(),
        kind: input.kind,
        objectId: input.objectId,
        part: input.part,
        bodyMediaType: input.bodyMediaType,
        bodyEncoding: input.bodyEncoding ?? "identity",
      },
      input.body,
      previousDigest,
      limits.maxHeaderBytes,
      options.crypto,
    );
    for (const part of encoded.parts) yield part;
    offset += encoded.byteLength;
    previousDigest = encoded.digest;
    sequence += 1;
    const count =
      observed.get(input.objectId) ??
      {
        frames: 0n,
        bodyBytes: 0n,
        semantic: await ObjectSemanticDigestV1.create(input.objectId, options.crypto),
      };
    await count.semantic.append(input);
    count.frames += 1n;
    count.bodyBytes += BigInt(input.body.byteLength);
    observed.set(input.objectId, count);
  }

  const resolvedManifest = await manifest;
  assertArchiveManifest(resolvedManifest);
  await validateObservedInventory(
    resolvedManifest,
    observed,
    BigInt(sequence),
    totalBodyBytes,
  );
  const manifestOffset = offset;
  const manifestBody = canonicalJsonBytes(resolvedManifest, {
    maxBytes: limits.maxBodyBytes,
  });
  totalBodyBytes += BigInt(manifestBody.byteLength);
  if (totalBodyBytes > limits.maxTotalBodyBytes) {
    fail("limit_exceeded", "inner archive exceeds its total body byte limit");
  }
  const encodedManifest = await encodeFrame(
    {
      sequence: sequence.toString(),
      kind: "manifest",
      objectId: resolvedManifest.archiveId,
      part: 0,
      bodyMediaType: MANIFEST_MEDIA_TYPE,
      bodyEncoding: "identity",
    },
    manifestBody,
    previousDigest,
    limits.maxHeaderBytes,
    options.crypto,
  );
  for (const part of encodedManifest.parts) yield part;
  const manifestDigest = await sha256Parts([manifestBody], options.crypto);
  yield concatBytes([
    TRAILER_MAGIC,
    encodeU64(manifestOffset),
    manifestDigest,
  ]);
}

export async function encodeInnerArchive(
  frames: readonly ArchiveDataFrameInput[],
  manifest: ArchiveManifestSource,
  options: InnerArchiveLimits & Readonly<{ crypto?: PortableCrypto }> = {},
): Promise<Uint8Array> {
  return collectBytes(encodeInnerArchiveStream(frames, manifest, options));
}

export async function validateInnerArchive(
  source: ByteSource,
  options: InnerArchiveValidationOptions = {},
): Promise<InnerArchiveValidationResult> {
  const reader = new ByteReader(source);
  try {
    return await validateInnerArchiveFromReader(reader, resolveLimits(options), options);
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function validateInnerArchiveFromReader(
  reader: ByteReader,
  limits: Required<InnerArchiveLimits>,
  options: InnerArchiveValidationOptions,
): Promise<InnerArchiveValidationResult> {
  const magic = await reader.readExactly(INNER_MAGIC.byteLength, "inner archive magic");
  if (!equalBytes(magic, INNER_MAGIC)) {
    fail("invalid_magic", "inner archive magic or version is invalid");
  }

  let previousDigest: Uint8Array = ZERO_SHA256;
  let sequence = 0;
  let dataBodyBytes = 0n;
  let totalBodyBytes = 0n;
  const observed = new Map<string, ObservedObject>();
  const objectRuns = new ContiguousObjectRunTracker();

  while (true) {
    if (sequence >= limits.maxFrames) {
      fail("limit_exceeded", "inner archive exceeds its frame limit");
    }
    const frameOffset = reader.position;
    const headerLengthBytes = await reader.readExactly(4, "frame header length");
    const headerLength = decodeU32(headerLengthBytes);
    if (headerLength === 0 || headerLength > limits.maxHeaderBytes) {
      fail("limit_exceeded", "frame header length is outside the configured limit");
    }
    const bodyLengthBytes = await reader.readExactly(8, "frame body length");
    const bodyLength = decodeU64(bodyLengthBytes);
    if (bodyLength > BigInt(limits.maxBodyBytes)) {
      fail("limit_exceeded", "frame body length is outside the configured limit");
    }
    totalBodyBytes += bodyLength;
    if (totalBodyBytes > limits.maxTotalBodyBytes) {
      fail("limit_exceeded", "inner archive exceeds its total body byte limit");
    }
    const headerBytes = await reader.readExactly(headerLength, "frame header");
    const headerValue = parseCanonicalJson(headerBytes, {
      maxBytes: limits.maxHeaderBytes,
    });
    const header = parseFrameHeader(headerValue, sequence, previousDigest);
    const body = await reader.readExactly(Number(bodyLength), "frame body");
    const bodyDigest = await sha256Parts([body], options.crypto);
    if (!equalBytes(bodyDigest, decodeDigest(header.bodySha256, "bodySha256"))) {
      fail("integrity_error", `frame ${sequence} body digest does not match its header`);
    }
    const digest = await sha256Parts(
      [headerLengthBytes, bodyLengthBytes, headerBytes, body],
      options.crypto,
    );
    const decodedFrame = Object.freeze({
      offset: frameOffset,
      header: Object.freeze(header),
      headerBytes,
      body,
      digest,
    });
    if (header.kind !== "manifest") {
      objectRuns.observe(header.objectId, (message) => fail("invalid_frame", message));
    }
    if (options.onFrame) await options.onFrame(decodedFrame);
    previousDigest = digest;

    if (header.kind === "manifest") {
      if (header.part !== 0 || header.bodyMediaType !== MANIFEST_MEDIA_TYPE) {
        fail("invalid_manifest", "manifest frame has invalid part or media type");
      }
      const manifestValue = parseCanonicalJson(body, { maxBytes: limits.maxBodyBytes });
      assertArchiveManifest(manifestValue);
      if (header.objectId !== manifestValue.archiveId) {
        fail("invalid_manifest", "manifest frame objectId does not match archiveId");
      }
      await validateObservedInventory(
        manifestValue,
        observed,
        BigInt(sequence),
        dataBodyBytes,
      );
      const trailer = await reader.readExactly(
        TRAILER_MAGIC.byteLength + 8 + SHA256_BYTES,
        "inner archive trailer",
      );
      if (!equalBytes(trailer.subarray(0, TRAILER_MAGIC.byteLength), TRAILER_MAGIC)) {
        fail("invalid_trailer", "inner archive trailer magic is invalid");
      }
      const recordedOffset = decodeU64(
        trailer.subarray(TRAILER_MAGIC.byteLength, TRAILER_MAGIC.byteLength + 8),
      );
      if (recordedOffset !== frameOffset) {
        fail("invalid_trailer", "inner archive trailer has the wrong manifest offset");
      }
      const recordedDigest = trailer.subarray(TRAILER_MAGIC.byteLength + 8);
      if (!equalBytes(recordedDigest, bodyDigest)) {
        fail("invalid_trailer", "inner archive trailer has the wrong manifest digest");
      }
      await reader.requireEnd();
      return {
        manifest: manifestValue,
        manifestOffset: frameOffset,
        dataFrameCount: sequence,
        frameCount: sequence + 1,
        dataBodyBytes,
        totalBodyBytes,
        finalFrameDigest: digest,
      };
    }

    dataBodyBytes += bodyLength;
    const count =
      observed.get(header.objectId) ??
      {
        frames: 0n,
        bodyBytes: 0n,
        semantic: await ObjectSemanticDigestV1.create(header.objectId, options.crypto),
      };
    await count.semantic.append({
      kind: header.kind,
      part: header.part,
      bodyMediaType: header.bodyMediaType,
      bodyEncoding: header.bodyEncoding,
      body,
    });
    count.frames += 1n;
    count.bodyBytes += bodyLength;
    observed.set(header.objectId, count);
    sequence += 1;
  }
}

export async function decodeInnerArchive(
  source: ByteSource,
  options: Omit<InnerArchiveValidationOptions, "onFrame"> = {},
): Promise<
  InnerArchiveValidationResult & Readonly<{ frames: readonly DecodedArchiveFrame[] }>
> {
  const frames: DecodedArchiveFrame[] = [];
  const result = await validateInnerArchive(source, {
    ...options,
    onFrame: (frame) => {
      frames.push(frame);
    },
  });
  return { ...result, frames };
}

async function encodeFrame(
  fields: Omit<ArchiveFrameHeaderV1, "bodySha256" | "previousFrameDigest">,
  body: Uint8Array,
  previousDigest: Uint8Array,
  maxHeaderBytes: number,
  crypto?: PortableCrypto,
): Promise<Readonly<{
  parts: readonly Uint8Array[];
  digest: Uint8Array;
  byteLength: bigint;
}>> {
  const bodyDigest = await sha256Parts([body], crypto);
  const header: ArchiveFrameHeaderV1 = {
    ...fields,
    bodySha256: encodeBase64Url(bodyDigest),
    previousFrameDigest: encodeBase64Url(previousDigest),
  };
  const headerBytes = canonicalJsonBytes(header, { maxBytes: maxHeaderBytes });
  const headerLength = encodeU32(headerBytes.byteLength);
  const bodyLength = encodeU64(BigInt(body.byteLength));
  const digest = await sha256Parts(
    [headerLength, bodyLength, headerBytes, body],
    crypto,
  );
  return {
    parts: [headerLength, bodyLength, headerBytes, body],
    digest,
    byteLength: BigInt(12 + headerBytes.byteLength + body.byteLength),
  };
}

function parseFrameHeader(
  value: unknown,
  expectedSequence: number,
  expectedPreviousDigest: Uint8Array,
): ArchiveFrameHeaderV1 {
  const header = expectRecord(value, "frame header");
  expectExactKeys(
    header,
    [
      "sequence",
      "kind",
      "objectId",
      "part",
      "bodyMediaType",
      "bodyEncoding",
      "bodySha256",
      "previousFrameDigest",
    ],
    "frame header",
  );
  if (header.sequence !== expectedSequence.toString()) {
    fail("invalid_frame", "frame sequence is missing, repeated, or noncanonical");
  }
  if (typeof header.kind !== "string" || !FRAME_KINDS.has(header.kind as ArchiveFrameKind)) {
    fail("invalid_frame", "frame kind is unknown");
  }
  const objectId = validateIdentifier(header.objectId, "frame objectId", 1024);
  const part = validateU32(header.part, "frame part");
  const bodyMediaType = validateMediaType(header.bodyMediaType);
  if (header.bodyEncoding !== "identity") {
    fail("invalid_frame", "v1 frame bodyEncoding must be identity");
  }
  if (typeof header.bodySha256 !== "string") {
    fail("invalid_frame", "frame bodySha256 must be a string");
  }
  decodeDigest(header.bodySha256, "bodySha256");
  if (typeof header.previousFrameDigest !== "string") {
    fail("invalid_frame", "frame previousFrameDigest must be a string");
  }
  const previous = decodeDigest(header.previousFrameDigest, "previousFrameDigest");
  if (!equalBytes(previous, expectedPreviousDigest)) {
    fail("integrity_error", "frame hash chain does not match the preceding frame");
  }
  return {
    sequence: header.sequence,
    kind: header.kind as ArchiveFrameKind,
    objectId,
    part,
    bodyMediaType,
    bodyEncoding: "identity",
    bodySha256: header.bodySha256,
    previousFrameDigest: header.previousFrameDigest,
  };
}

function validateDataFrameInput(
  input: ArchiveDataFrameInput,
  maxBodyBytes: number,
): void {
  if (!DATA_FRAME_KINDS.has(input.kind)) {
    fail("invalid_frame", "data frame kind is invalid or reserved for the manifest");
  }
  validateIdentifier(input.objectId, "frame objectId", 1024);
  validateU32(input.part, "frame part");
  validateMediaType(input.bodyMediaType);
  if (input.bodyEncoding !== undefined && input.bodyEncoding !== "identity") {
    fail("invalid_frame", "v1 frame bodyEncoding must be identity");
  }
  if (!(input.body instanceof Uint8Array)) {
    fail("invalid_frame", "frame body must be a Uint8Array");
  }
  if (input.body.byteLength > maxBodyBytes) {
    fail("limit_exceeded", "frame body exceeds the configured limit");
  }
}

async function validateObservedInventory(
  manifest: ArchiveManifestV1,
  observed: ReadonlyMap<string, ObservedObject>,
  frameCount: bigint,
  bodyBytes: bigint,
): Promise<void> {
  if (
    BigInt(manifest.totals.dataFrames) !== frameCount ||
    BigInt(manifest.totals.dataBodyBytes) !== bodyBytes
  ) {
    fail("invalid_manifest", "manifest data totals do not match the frame stream");
  }
  if (observed.size !== manifest.inventory.length) {
    fail("invalid_manifest", "manifest inventory does not exactly cover frame object IDs");
  }
  for (const item of manifest.inventory) {
    const count = observed.get(item.objectId);
    if (
      !count ||
      count.frames !== BigInt(item.frameCount) ||
      count.bodyBytes !== BigInt(item.bodyBytes) ||
      count.semantic.digestBase64Url() !== item.semanticSha256
    ) {
      fail(
        "invalid_manifest",
        `manifest counts or semantic digest do not match object ${item.objectId}`,
      );
    }
  }
}

function resolveLimits(limits: InnerArchiveLimits): Required<InnerArchiveLimits> {
  const result = {
    maxHeaderBytes: limits.maxHeaderBytes ?? DEFAULT_MAX_FRAME_HEADER_BYTES,
    maxBodyBytes: limits.maxBodyBytes ?? MAX_FRAME_BODY_BYTES,
    maxFrames: limits.maxFrames ?? DEFAULT_MAX_FRAMES,
    maxTotalBodyBytes: limits.maxTotalBodyBytes ?? DEFAULT_MAX_TOTAL_BODY_BYTES,
  };
  if (
    !Number.isSafeInteger(result.maxHeaderBytes) ||
    result.maxHeaderBytes <= 0 ||
    result.maxHeaderBytes > 1024 * 1024
  ) {
    fail("invalid_argument", "maxHeaderBytes must be between 1 and 1 MiB");
  }
  if (
    !Number.isSafeInteger(result.maxBodyBytes) ||
    result.maxBodyBytes < 0 ||
    result.maxBodyBytes > MAX_FRAME_BODY_BYTES
  ) {
    fail("invalid_argument", "maxBodyBytes must be between 0 and 4 MiB");
  }
  if (
    !Number.isSafeInteger(result.maxFrames) ||
    result.maxFrames < 1 ||
    result.maxFrames > 0xffff_ffff
  ) {
    fail("invalid_argument", "maxFrames must be between 1 and 2^32-1");
  }
  if (result.maxTotalBodyBytes < 0n || result.maxTotalBodyBytes > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_argument", "maxTotalBodyBytes is outside the unsigned 64-bit range");
  }
  return result;
}

function validateIdentifier(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    fail("invalid_frame", `${label} is empty, contains controls, or exceeds its limit`);
  }
  return value;
}

function validateMediaType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 127 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/.test(value)
  ) {
    fail("invalid_frame", "frame bodyMediaType is invalid");
  }
  return value;
}

function validateU32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    fail("invalid_frame", `${label} is outside the unsigned 32-bit range`);
  }
  return value;
}

function decodeDigest(value: string, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch (error) {
    fail("invalid_frame", `${label} is not canonical base64url: ${String(error)}`);
  }
  if (bytes.byteLength !== SHA256_BYTES) {
    fail("invalid_frame", `${label} must contain a SHA-256 digest`);
  }
  return bytes;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_frame", `${label} must be an object`);
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
    fail("invalid_frame", `${label} has unexpected or missing fields`);
  }
}

const FRAME_KINDS = new Set<ArchiveFrameKind>([
  "tenant",
  "do.descriptor",
  "do.sqlite.schema",
  "do.sqlite.rows",
  "do.sqlite.cell",
  "do.kv",
  "r2.descriptor",
  "r2.body",
  "workers-kv.descriptor",
  "workers-kv.value",
  "manifest",
]);

const DATA_FRAME_KINDS = new Set<ArchiveDataFrameKind>([
  "tenant",
  "do.descriptor",
  "do.sqlite.schema",
  "do.sqlite.rows",
  "do.sqlite.cell",
  "do.kv",
  "r2.descriptor",
  "r2.body",
  "workers-kv.descriptor",
  "workers-kv.value",
]);
