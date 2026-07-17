export const DATA_FRAME_STREAM_MEDIA_TYPE =
  "application/vnd.gsv.data-frame-stream.v1" as const;
export const DATA_FRAME_STREAM_CONTROL_KIND = "gsv.restore.control" as const;
export const DATA_FRAME_STREAM_CANONICAL_JSON_MEDIA_TYPE = "application/json" as const;

export const DATA_FRAME_STREAM_MAX_KIND_BYTES = 64;
export const DATA_FRAME_STREAM_MAX_OBJECT_ID_BYTES = 1024;
export const DATA_FRAME_STREAM_MAX_MEDIA_TYPE_BYTES = 127;
export const DATA_FRAME_STREAM_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DATA_FRAME_STREAM_MAX_FRAMES = 10_000_000;
export const DATA_FRAME_STREAM_MAX_TOTAL_BODY_BYTES = 16n * 1024n * 1024n * 1024n;
export const DATA_FRAME_STREAM_MAX_RESTORE_CONTROL_BYTES = 16 * 1024;

const DATA_FRAME_STREAM_MAGIC = new Uint8Array([
  0x47, 0x53, 0x56, 0x44, 0x46, 0x00, 0x01, 0x0a,
]);
const DATA_FRAME_STREAM_PREFIX_BYTES = 18;
const DATA_FRAME_STREAM_TERMINATOR = new Uint8Array(DATA_FRAME_STREAM_PREFIX_BYTES);
const CONTROL_CHARACTERS = /\p{Cc}/u;
const MEDIA_TYPE =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type DataFrameStreamRecord = Readonly<{
  kind: string;
  objectId: string;
  part: number;
  bodyMediaType: string;
  body: Uint8Array;
}>;

export type DataFrameStreamLimits = Readonly<{
  maxKindBytes?: number;
  maxObjectIdBytes?: number;
  maxMediaTypeBytes?: number;
  maxBodyBytes?: number;
  maxFirstBodyBytes?: number;
  maxFrames?: number;
  maxTotalBodyBytes?: bigint;
}>;

export type ManagedPortableComponent =
  | "gateway"
  | "whatsapp"
  | "discord"
  | "telegram"
  | "ripgit";

export type ManagedPortableObjectKind =
  | "kernel"
  | "process"
  | "app_runner"
  | "adapter_account"
  | "repository";

export type ManagedObjectSnapshotRequest = Readonly<{
  component: ManagedPortableComponent;
  kind: ManagedPortableObjectKind;
  providerId: string;
  logicalName: string;
  objectId: string;
  fenceEpoch: number;
}>;

/**
 * The first record of every restore stream. It is transport control metadata,
 * not an archive data frame, and must be removed before owner restore codecs
 * see the stream. The authenticated coordinator is the trust boundary for
 * issuing a unique restoreId for each logical restore; an exact completed
 * (restoreId, objectId) pair is intentionally treated as an idempotent replay.
 */
export type ManagedObjectRestoreControl = Readonly<{
  component: ManagedPortableComponent;
  kind: ManagedPortableObjectKind;
  logicalName: string;
  objectId: string;
  restoreId: string;
  fenceEpoch: number;
  frameCount: string;
  bodyBytes: string;
  semanticSha256: string;
}>;

export function validateManagedSnapshotRequest(value: unknown): ManagedObjectSnapshotRequest {
  if (!isPlainRecord(value)) {
    throw new TypeError("Managed snapshot request must be an object");
  }
  assertExactKeys(value, [
    "component",
    "fenceEpoch",
    "kind",
    "logicalName",
    "objectId",
    "providerId",
  ]);
  if (!isPortableComponent(value.component) || !isPortableKindForComponent(value.kind, value.component)) {
    throw new TypeError("Managed snapshot component and kind are invalid");
  }
  validateIdentifier(value.logicalName, "logicalName");
  validateIdentifier(value.objectId, "objectId");
  if (typeof value.providerId !== "string") {
    throw new TypeError("Managed snapshot providerId is invalid");
  }
  const providerBytes = validateText(value.providerId, "providerId", 128);
  if (providerBytes === 0) throw new TypeError("Managed snapshot providerId must not be empty");
  validateFenceEpoch(value.fenceEpoch);
  return Object.freeze({
    component: value.component,
    kind: value.kind,
    providerId: value.providerId,
    logicalName: value.logicalName,
    objectId: value.objectId,
    fenceEpoch: value.fenceEpoch,
  });
}

/** Encode records without buffering the stream or converting bodies to text. */
export function encodeDataFrameStream(
  records: Iterable<DataFrameStreamRecord> | AsyncIterable<DataFrameStreamRecord>,
  options: DataFrameStreamLimits = {},
): ReadableStream<Uint8Array> {
  const limits = resolveLimits(options);
  const iterator = toAsyncIterator(records);
  let phase: "magic" | "records" | "terminator" | "done" = "magic";
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let frameCount = 0;
  let totalBodyBytes = 0n;
  let sourceClosed = false;

  const closeSource = async (reason?: unknown): Promise<void> => {
    if (sourceClosed) return;
    sourceClosed = true;
    if (iterator.return) await iterator.return(reason).catch(() => {});
  };

  const source: UnderlyingByteSource = {
    type: "bytes",
    async pull(controller) {
      try {
        if (phase === "magic") {
          phase = "records";
          controller.enqueue(DATA_FRAME_STREAM_MAGIC.slice());
          return;
        }
        if (pending.length > 0) {
          controller.enqueue(pending.shift()!);
          return;
        }
        if (phase === "records") {
          const next = await iterator.next();
          if (next.done) {
            sourceClosed = true;
            phase = "terminator";
          } else {
            if (frameCount >= limits.maxFrames) {
              throw new RangeError("Data frame stream exceeds its frame limit");
            }
            if (frameCount === 0 && next.value.body.byteLength > limits.maxFirstBodyBytes) {
              throw new RangeError("First data frame body exceeds its configured limit");
            }
            const encoded = encodeRecord(next.value, limits);
            totalBodyBytes += BigInt(next.value.body.byteLength);
            if (totalBodyBytes > limits.maxTotalBodyBytes) {
              throw new RangeError("Data frame stream exceeds its total body byte limit");
            }
            frameCount += 1;
            pending = encoded;
            controller.enqueue(pending.shift()!);
            return;
          }
        }
        if (phase === "terminator") {
          phase = "done";
          controller.enqueue(DATA_FRAME_STREAM_TERMINATOR.slice());
          return;
        }
        controller.close();
      } catch (error) {
        await closeSource(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      phase = "done";
      pending = [];
      await closeSource(reason);
    },
  };
  // TypeScript's DOM declarations do not currently connect
  // `UnderlyingByteSource` to the generic ReadableStream constructor even
  // though `type: "bytes"` is the standard byte-stream discriminator.
  return new ReadableStream<Uint8Array>(
    source as unknown as UnderlyingSource<Uint8Array>,
  );
}

/** Decode a bounded record stream and cancel its source on error or early exit. */
export async function* decodeDataFrameStream(
  stream: ReadableStream<Uint8Array>,
  options: DataFrameStreamLimits = {},
): AsyncGenerator<DataFrameStreamRecord> {
  const limits = resolveLimits(options);
  const reader = new DataFrameByteReader(stream);
  let complete = false;
  let frameCount = 0;
  let totalBodyBytes = 0n;
  try {
    const magic = await reader.readExactly(DATA_FRAME_STREAM_MAGIC.byteLength, "stream magic");
    if (!equalBytes(magic, DATA_FRAME_STREAM_MAGIC)) {
      throw new TypeError("Data frame stream magic or version is invalid");
    }
    for (;;) {
      const prefix = await reader.readExactly(DATA_FRAME_STREAM_PREFIX_BYTES, "record prefix");
      if (isAllZero(prefix)) {
        await reader.requireEnd();
        complete = true;
        return;
      }
      if (frameCount >= limits.maxFrames) {
        throw new RangeError("Data frame stream exceeds its frame limit");
      }
      const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const kindBytes = view.getUint16(0, false);
      const objectIdBytes = view.getUint16(2, false);
      const mediaTypeBytes = view.getUint16(4, false);
      const part = view.getUint32(6, false);
      const bodyBytes = view.getBigUint64(10, false);
      if (
        kindBytes === 0
        || kindBytes > limits.maxKindBytes
        || objectIdBytes === 0
        || objectIdBytes > limits.maxObjectIdBytes
        || mediaTypeBytes === 0
        || mediaTypeBytes > limits.maxMediaTypeBytes
        || bodyBytes > BigInt(
          frameCount === 0 ? limits.maxFirstBodyBytes : limits.maxBodyBytes,
        )
      ) {
        throw new RangeError("Data frame record length is outside the configured limit");
      }
      totalBodyBytes += bodyBytes;
      if (totalBodyBytes > limits.maxTotalBodyBytes) {
        throw new RangeError("Data frame stream exceeds its total body byte limit");
      }
      const kind = decodeText(
        await reader.readExactly(kindBytes, "record kind"),
        "kind",
      );
      const objectId = decodeText(
        await reader.readExactly(objectIdBytes, "record object ID"),
        "objectId",
      );
      const bodyMediaType = decodeText(
        await reader.readExactly(mediaTypeBytes, "record media type"),
        "bodyMediaType",
      );
      const body = await reader.readExactly(Number(bodyBytes), "record body");
      const record = { kind, objectId, part, bodyMediaType, body };
      validateRecord(record, limits);
      frameCount += 1;
      yield Object.freeze(record);
    }
  } finally {
    await reader.finish(complete);
  }
}

export function encodeManagedRestoreControl(
  control: ManagedObjectRestoreControl,
): DataFrameStreamRecord {
  const parsed = validateManagedRestoreControl(control);
  const body = textEncoder.encode(JSON.stringify({
    bodyBytes: parsed.bodyBytes,
    component: parsed.component,
    fenceEpoch: parsed.fenceEpoch,
    frameCount: parsed.frameCount,
    kind: parsed.kind,
    logicalName: parsed.logicalName,
    objectId: parsed.objectId,
    restoreId: parsed.restoreId,
    semanticSha256: parsed.semanticSha256,
  }));
  return Object.freeze({
    kind: DATA_FRAME_STREAM_CONTROL_KIND,
    objectId: parsed.objectId,
    part: 0,
    bodyMediaType: DATA_FRAME_STREAM_CANONICAL_JSON_MEDIA_TYPE,
    body,
  });
}

export function decodeManagedRestoreControl(
  record: DataFrameStreamRecord,
): ManagedObjectRestoreControl {
  if (
    record.kind !== DATA_FRAME_STREAM_CONTROL_KIND
    || record.part !== 0
    || record.bodyMediaType !== DATA_FRAME_STREAM_CANONICAL_JSON_MEDIA_TYPE
  ) {
    throw new TypeError("Restore stream must begin with its canonical control record");
  }
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(record.body));
  } catch {
    throw new TypeError("Restore control record is not valid UTF-8 JSON");
  }
  const control = validateManagedRestoreControl(value);
  if (control.objectId !== record.objectId) {
    throw new TypeError("Restore control objectId does not match its record envelope");
  }
  const canonical = encodeManagedRestoreControl(control).body;
  if (!equalBytes(canonical, record.body)) {
    throw new TypeError("Restore control record is not canonical JSON");
  }
  return control;
}

export function validateManagedRestoreControl(value: unknown): ManagedObjectRestoreControl {
  if (!isPlainRecord(value)) {
    throw new TypeError("Managed restore control must be an object");
  }
  assertExactKeys(value, [
    "bodyBytes",
    "component",
    "fenceEpoch",
    "frameCount",
    "kind",
    "logicalName",
    "objectId",
    "restoreId",
    "semanticSha256",
  ]);
  if (!isPortableComponent(value.component) || !isPortableKindForComponent(value.kind, value.component)) {
    throw new TypeError("Managed restore component and kind are invalid");
  }
  validateIdentifier(value.logicalName, "logicalName");
  validateIdentifier(value.objectId, "objectId");
  validateIdentifier(value.restoreId, "restoreId");
  validateFenceEpoch(value.fenceEpoch);
  const frameCount = parseBoundedCount(
    value.frameCount,
    BigInt(DATA_FRAME_STREAM_MAX_FRAMES - 1),
  );
  const bodyBytes = parseBoundedCount(
    value.bodyBytes,
    DATA_FRAME_STREAM_MAX_TOTAL_BODY_BYTES
      - BigInt(DATA_FRAME_STREAM_MAX_RESTORE_CONTROL_BYTES),
  );
  if (typeof value.semanticSha256 !== "string" || !SHA256_BASE64URL.test(value.semanticSha256)) {
    throw new TypeError("Managed restore semanticSha256 is invalid");
  }
  return Object.freeze({
    component: value.component,
    kind: value.kind,
    logicalName: value.logicalName,
    objectId: value.objectId,
    restoreId: value.restoreId,
    fenceEpoch: value.fenceEpoch,
    frameCount: frameCount.toString(),
    bodyBytes: bodyBytes.toString(),
    semanticSha256: value.semanticSha256,
  });
}

function encodeRecord(
  record: DataFrameStreamRecord,
  limits: ResolvedLimits,
): Uint8Array<ArrayBuffer>[] {
  validateRecord(record, limits);
  const kind = textEncoder.encode(record.kind);
  const objectId = textEncoder.encode(record.objectId);
  const mediaType = textEncoder.encode(record.bodyMediaType);
  const prefix = new Uint8Array(DATA_FRAME_STREAM_PREFIX_BYTES);
  const view = new DataView(prefix.buffer);
  view.setUint16(0, kind.byteLength, false);
  view.setUint16(2, objectId.byteLength, false);
  view.setUint16(4, mediaType.byteLength, false);
  view.setUint32(6, record.part, false);
  view.setBigUint64(10, BigInt(record.body.byteLength), false);
  return [prefix, kind, objectId, mediaType, copyBytes(record.body)];
}

function validateRecord(record: DataFrameStreamRecord, limits: ResolvedLimits): void {
  if (!record || typeof record !== "object") {
    throw new TypeError("Data frame record must be an object");
  }
  const kindBytes = validateText(record.kind, "kind", limits.maxKindBytes);
  const objectIdBytes = validateText(record.objectId, "objectId", limits.maxObjectIdBytes);
  const mediaTypeBytes = validateText(
    record.bodyMediaType,
    "bodyMediaType",
    limits.maxMediaTypeBytes,
  );
  if (kindBytes === 0 || objectIdBytes === 0 || mediaTypeBytes === 0) {
    throw new TypeError("Data frame record text fields must not be empty");
  }
  if (!MEDIA_TYPE.test(record.bodyMediaType)) {
    throw new TypeError("Data frame record media type is invalid");
  }
  if (!Number.isSafeInteger(record.part) || record.part < 0 || record.part > 0xffff_ffff) {
    throw new RangeError("Data frame record part is outside the unsigned 32-bit range");
  }
  if (!(record.body instanceof Uint8Array)) {
    throw new TypeError("Data frame record body must be a Uint8Array");
  }
  if (record.body.byteLength > limits.maxBodyBytes) {
    throw new RangeError("Data frame record body exceeds its configured limit");
  }
}

type ResolvedLimits = Required<DataFrameStreamLimits>;

function resolveLimits(options: DataFrameStreamLimits): ResolvedLimits {
  const maxBodyBytes = boundedInteger(
    options.maxBodyBytes,
    DATA_FRAME_STREAM_MAX_BODY_BYTES,
    "maxBodyBytes",
  );
  return {
    maxKindBytes: boundedInteger(
      options.maxKindBytes,
      DATA_FRAME_STREAM_MAX_KIND_BYTES,
      "maxKindBytes",
    ),
    maxObjectIdBytes: boundedInteger(
      options.maxObjectIdBytes,
      DATA_FRAME_STREAM_MAX_OBJECT_ID_BYTES,
      "maxObjectIdBytes",
    ),
    maxMediaTypeBytes: boundedInteger(
      options.maxMediaTypeBytes,
      DATA_FRAME_STREAM_MAX_MEDIA_TYPE_BYTES,
      "maxMediaTypeBytes",
    ),
    maxBodyBytes,
    maxFirstBodyBytes: boundedInteger(
      options.maxFirstBodyBytes,
      maxBodyBytes,
      "maxFirstBodyBytes",
    ),
    maxFrames: boundedInteger(
      options.maxFrames,
      DATA_FRAME_STREAM_MAX_FRAMES,
      "maxFrames",
    ),
    maxTotalBodyBytes: boundedBigInt(
      options.maxTotalBodyBytes,
      DATA_FRAME_STREAM_MAX_TOTAL_BODY_BYTES,
      "maxTotalBodyBytes",
    ),
  };
}

function boundedInteger(value: number | undefined, maximum: number, label: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`Data frame stream ${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}

function boundedBigInt(value: bigint | undefined, maximum: bigint, label: string): bigint {
  const resolved = value ?? maximum;
  if (typeof resolved !== "bigint" || resolved < 1n || resolved > maximum) {
    throw new RangeError(`Data frame stream ${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}

function validateText(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`Data frame record ${label} is invalid`);
  }
  assertWellFormedUnicode(value, label);
  const length = textEncoder.encode(value).byteLength;
  if (length > maximum) {
    throw new RangeError(`Data frame record ${label} exceeds its configured limit`);
  }
  return length;
}

function decodeText(bytes: Uint8Array, label: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new TypeError(`Data frame record ${label} is not valid UTF-8`);
  }
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  const length = validateText(value, label, DATA_FRAME_STREAM_MAX_OBJECT_ID_BYTES);
  if (length === 0) throw new TypeError(`Managed restore ${label} must not be empty`);
}

function validateFenceEpoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Managed restore fenceEpoch is invalid");
  }
}

function parseBoundedCount(value: unknown, maximum: bigint): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) {
    throw new TypeError("Managed restore count is not a canonical unsigned decimal string");
  }
  const count = BigInt(value);
  if (count > maximum) throw new RangeError("Managed restore count exceeds the transport limit");
  return count;
}

function isPortableComponent(value: unknown): value is ManagedPortableComponent {
  return value === "gateway"
    || value === "whatsapp"
    || value === "discord"
    || value === "telegram"
    || value === "ripgit";
}

function isPortableKindForComponent(
  value: unknown,
  component: ManagedPortableComponent,
): value is ManagedPortableObjectKind {
  return component === "gateway"
    ? value === "kernel" || value === "process" || value === "app_runner"
    : component === "ripgit"
      ? value === "repository"
      : value === "adapter_account";
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Managed restore control has unknown or missing fields");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`Data frame record ${label} contains invalid Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`Data frame record ${label} contains invalid Unicode`);
    }
  }
}

function toAsyncIterator<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncIterator<T> {
  const asyncIterator = (source as AsyncIterable<T>)[Symbol.asyncIterator]?.();
  if (asyncIterator) return asyncIterator;
  const iterator = (source as Iterable<T>)[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("Data frame source is not iterable");
  return {
    next: async () => iterator.next(),
    return: iterator.return
      ? async (value?: unknown) => iterator.return!(value as never)
      : undefined,
    throw: iterator.throw
      ? async (error?: unknown) => iterator.throw!(error)
      : undefined,
  };
}

class DataFrameByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #offset = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async readExactly(length: number, label: string): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.#offset === this.#chunk.byteLength) await this.#readChunk();
      if (this.#ended) throw new TypeError(`Data frame stream ended during ${label}`);
      const available = this.#chunk.byteLength - this.#offset;
      const copied = Math.min(available, length - written);
      result.set(this.#chunk.subarray(this.#offset, this.#offset + copied), written);
      this.#offset += copied;
      written += copied;
    }
    return result;
  }

  async requireEnd(): Promise<void> {
    if (this.#offset < this.#chunk.byteLength) {
      throw new TypeError("Data frame stream has bytes after its terminator");
    }
    await this.#readChunk();
    if (!this.#ended) throw new TypeError("Data frame stream has bytes after its terminator");
  }

  async finish(complete: boolean): Promise<void> {
    try {
      if (!complete) await this.#reader.cancel("Data frame stream was not fully consumed");
    } catch {
      // The decoding or consumer error remains authoritative.
    } finally {
      this.#reader.releaseLock();
    }
  }

  async #readChunk(): Promise<void> {
    while (!this.#ended) {
      const next = await this.#reader.read();
      if (next.done) {
        this.#ended = true;
        this.#chunk = new Uint8Array();
        this.#offset = 0;
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("Data frame stream source emitted a non-byte chunk");
      }
      if (next.value.byteLength === 0) continue;
      this.#chunk = next.value;
      this.#offset = 0;
      return;
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function isAllZero(bytes: Uint8Array): boolean {
  let combined = 0;
  for (const byte of bytes) combined |= byte;
  return combined === 0;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
