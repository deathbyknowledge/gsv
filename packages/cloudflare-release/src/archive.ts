export type CloudflareBundleByteSource =
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export type CloudflareWorkerBundleLimits = Readonly<{
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
}>;

export type CloudflareBundleArchiveStatistics = Readonly<{
  compressedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  totalFileBytes: number;
}>;

export type TarFile = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

export type ParsedTarArchive = Readonly<{
  files: readonly TarFile[];
  statistics: CloudflareBundleArchiveStatistics;
}>;

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;

export function assertCloudflareWorkerBundleLimits(
  limits: CloudflareWorkerBundleLimits,
): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Cloudflare bundle limit ${name} must be a positive integer`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalFileBytes) {
    throw new TypeError("Cloudflare bundle maxFileBytes must not exceed maxTotalFileBytes");
  }
  if (limits.maxTotalFileBytes > limits.maxUncompressedBytes) {
    throw new TypeError(
      "Cloudflare bundle maxTotalFileBytes must not exceed maxUncompressedBytes",
    );
  }
}

export async function readCloudflareBundleSource(
  source: CloudflareBundleByteSource,
  expectedBytes: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {
    throw new TypeError("Cloudflare bundle expected size must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("Cloudflare bundle compressed-byte limit must be a positive integer");
  }
  if (expectedBytes > maximumBytes) {
    throw new Error("Cloudflare bundle exceeds the compressed-byte limit");
  }
  throwIfAborted(signal);

  if (source instanceof Uint8Array) {
    if (source.byteLength !== expectedBytes) throwArtifactSizeMismatch();
    return source.slice();
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength !== expectedBytes) throwArtifactSizeMismatch();
    return new Uint8Array(source.slice(0));
  }
  if (isReadableStream(source)) {
    return readReadableStream(source, expectedBytes, signal);
  }
  if (isAsyncIterable(source)) {
    return readAsyncIterable(source, expectedBytes, signal);
  }
  throw new TypeError("Cloudflare bundle source must be bytes or a byte stream");
}

export async function gunzipCloudflareBundle(
  compressed: Uint8Array,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("Cloudflare bundle uncompressed-byte limit must be a positive integer");
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This runtime does not provide gzip decompression");
  }
  throwIfAborted(signal);

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  // TypeScript's DOM declarations model DecompressionStream input as the wider
  // BufferSource union. Both Workers and Node's Web Streams implementation
  // require Uint8Array chunks in practice.
  const decompressor = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const reader = input.pipeThrough(decompressor).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      const chunk = asByteChunk(next.value);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        throw new Error("Cloudflare bundle exceeds the uncompressed-byte limit");
      }
      if (chunk.byteLength > 0) chunks.push(chunk.slice());
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (signal?.aborted) throw abortReason(signal);
    if (error instanceof Error && error.message.includes("uncompressed-byte limit")) throw error;
    throw new Error("Cloudflare bundle is not a valid gzip stream", { cause: error });
  } finally {
    reader.releaseLock();
  }
  return concatenate(chunks, total);
}

export function parseCloudflareBundleTar(
  bytes: Uint8Array,
  limits: Pick<
    CloudflareWorkerBundleLimits,
    "maxUncompressedBytes" | "maxFiles" | "maxFileBytes" | "maxTotalFileBytes"
  >,
): ParsedTarArchive {
  if (bytes.byteLength > limits.maxUncompressedBytes) {
    throw new Error("Cloudflare bundle exceeds the uncompressed-byte limit");
  }

  const files: TarFile[] = [];
  const seen = new Set<string>();
  let totalFileBytes = 0;
  let offset = 0;
  let foundEnd = false;

  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (offset + TAR_END_BYTES > bytes.byteLength) {
        throw new Error("Cloudflare bundle tar is missing its second end marker");
      }
      if (!isZeroBlock(bytes.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_END_BYTES))) {
        throw new Error("Cloudflare bundle tar has only one end marker");
      }
      if (!isZeroBlock(bytes.subarray(offset + TAR_END_BYTES))) {
        throw new Error("Cloudflare bundle tar contains data after its end marker");
      }
      foundEnd = true;
      break;
    }

    verifyTarHeader(header);
    const rawName = readTarText(header, 0, 100, "name");
    const rawPrefix = readTarText(header, 345, 155, "prefix");
    const type = header[156] ?? 0;
    const directory = type === 0x35;
    const regularFile = type === 0 || type === 0x30;
    const path = normalizeTarPath(rawPrefix ? `${rawPrefix}/${rawName}` : rawName, directory);
    if (!directory && !regularFile) {
      throw new Error(
        `Cloudflare bundle tar entry ${path} uses unsupported type ${JSON.stringify(
          String.fromCharCode(type),
        )}`,
      );
    }
    if (seen.has(path)) {
      throw new Error(`Cloudflare bundle tar contains duplicate path ${path}`);
    }
    seen.add(path);

    const size = readTarOctal(header, 124, 12, "file size");
    if (directory && size !== 0) {
      throw new Error(`Cloudflare bundle tar directory ${path} has a body`);
    }
    if (size > limits.maxFileBytes) {
      throw new Error(`Cloudflare bundle tar file ${path} exceeds the per-file limit`);
    }
    const bodyOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(paddedSize) || bodyOffset + paddedSize > bytes.byteLength) {
      throw new Error(`Cloudflare bundle tar entry ${path} is truncated`);
    }

    if (regularFile) {
      if (files.length >= limits.maxFiles) {
        throw new Error("Cloudflare bundle tar contains too many files");
      }
      totalFileBytes += size;
      if (
        !Number.isSafeInteger(totalFileBytes)
        || totalFileBytes > limits.maxTotalFileBytes
      ) {
        throw new Error("Cloudflare bundle tar exceeds the total-file-byte limit");
      }
      files.push(Object.freeze({
        path,
        bytes: bytes.slice(bodyOffset, bodyOffset + size),
      }));
    }
    offset = bodyOffset + paddedSize;
  }

  if (!foundEnd) throw new Error("Cloudflare bundle tar is missing its end markers");
  return Object.freeze({
    files: Object.freeze(files),
    statistics: Object.freeze({
      compressedBytes: 0,
      uncompressedBytes: bytes.byteLength,
      fileCount: files.length,
      totalFileBytes,
    }),
  });
}

async function readReadableStream(
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readWithAbort(reader, signal);
      if (next.done) break;
      const chunk = asByteChunk(next.value);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > expectedBytes) throwArtifactSizeMismatch();
      if (chunk.byteLength > 0) chunks.push(chunk.slice());
    }
    if (total !== expectedBytes) throwArtifactSizeMismatch();
    return concatenate(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readAsyncIterable(
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await nextWithAbort(iterator, signal);
      if (next.done) {
        complete = true;
        break;
      }
      const chunk = asByteChunk(next.value);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > expectedBytes) throwArtifactSizeMismatch();
      if (chunk.byteLength > 0) chunks.push(chunk.slice());
    }
    if (total !== expectedBytes) throwArtifactSizeMismatch();
    return concatenate(chunks, total);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    if (!complete && typeof iterator.return === "function") {
      await iterator.return().catch(() => undefined);
    }
  }
}

async function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  return raceWithAbort(reader.read(), signal);
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  return raceWithAbort(iterator.next(), signal);
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function verifyTarHeader(header: Uint8Array): void {
  const expected = readTarOctal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw new Error("Cloudflare bundle tar header checksum mismatch");

  const magic = header.subarray(257, 263);
  if (
    magic[0] !== 0x75
    || magic[1] !== 0x73
    || magic[2] !== 0x74
    || magic[3] !== 0x61
    || magic[4] !== 0x72
    || (magic[5] !== 0 && magic[5] !== 0x20)
  ) {
    throw new Error("Cloudflare bundle tar entry is not in ustar format");
  }
}

function readTarText(
  header: Uint8Array,
  offset: number,
  length: number,
  label: string,
): string {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  const value = zero < 0 ? field : field.subarray(0, zero);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value);
  } catch (error) {
    throw new Error(`Cloudflare bundle tar ${label} is not valid UTF-8`, { cause: error });
  }
}

function readTarOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  label: string,
): number {
  const field = header.subarray(offset, offset + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    throw new Error(`Cloudflare bundle tar ${label} uses unsupported base-256 encoding`);
  }
  const text = new TextDecoder().decode(field).replaceAll("\0", "").trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) {
    throw new Error(`Cloudflare bundle tar ${label} is not valid octal`);
  }
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Cloudflare bundle tar ${label} is out of range`);
  }
  return parsed;
}

function normalizeTarPath(raw: string, directory: boolean): string {
  const withoutTrailingSlash = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (
    withoutTrailingSlash.length === 0
    || withoutTrailingSlash.length > 512
    || withoutTrailingSlash.startsWith("/")
    || withoutTrailingSlash.includes("\\")
    || /^[A-Za-z]:/u.test(withoutTrailingSlash)
    || /[\u0000-\u001f\u007f]/u.test(withoutTrailingSlash)
  ) {
    throw new Error("Cloudflare bundle tar contains an unsafe path");
  }
  const parts = withoutTrailingSlash.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Cloudflare bundle tar contains a traversing or non-canonical path");
  }
  return parts.join("/");
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function asByteChunk(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Cloudflare bundle byte stream produced a non-Uint8Array chunk");
  }
  return value;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof (value as ReadableStream<Uint8Array> | undefined)?.getReader === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof (value as AsyncIterable<Uint8Array> | undefined)?.[Symbol.asyncIterator]
    === "function";
}

function throwArtifactSizeMismatch(): never {
  throw new Error("Cloudflare bundle size does not match its release descriptor");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
