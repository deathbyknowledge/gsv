import { PortableArchiveError, fail } from "./error";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
  BASE64URL_VALUES[BASE64URL_ALPHABET.charCodeAt(index)] = index;
}

export type ByteSource =
  | Uint8Array
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
    if (!Number.isSafeInteger(length)) {
      fail("limit_exceeded", "byte sequence exceeds the JavaScript safe length");
    }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function encodeU32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail("invalid_argument", "u32 value is out of range");
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

export function decodeU32(bytes: Uint8Array): number {
  if (bytes.byteLength !== 4) {
    fail("invalid_argument", "u32 input must be exactly four bytes");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    false,
  );
}

export function encodeU64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    fail("invalid_argument", "u64 value is out of range");
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
}

export function decodeU64(bytes: Uint8Array): bigint {
  if (bytes.byteLength !== 8) {
    fail("invalid_argument", "u64 input must be exactly eight bytes");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
    0,
    false,
  );
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.byteLength ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.byteLength ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    result += BASE64URL_ALPHABET[(combined >>> 18) & 63];
    result += BASE64URL_ALPHABET[(combined >>> 12) & 63];
    if (index + 1 < bytes.byteLength) {
      result += BASE64URL_ALPHABET[(combined >>> 6) & 63];
    }
    if (index + 2 < bytes.byteLength) {
      result += BASE64URL_ALPHABET[combined & 63];
    }
  }
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1 ||
    value.includes("=")
  ) {
    fail("invalid_value", "base64url value is not canonical unpadded data");
  }
  const outputLength = Math.floor((value.length * 6) / 8);
  const result = new Uint8Array(outputLength);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const decoded = code < BASE64URL_VALUES.length ? BASE64URL_VALUES[code] : -1;
    if (decoded < 0) {
      fail("invalid_value", "base64url value contains an invalid character");
    }
    accumulator = (accumulator << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[outputIndex] = (accumulator >>> bits) & 0xff;
      outputIndex += 1;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    fail("invalid_value", "base64url value has non-zero trailing bits");
  }
  if (encodeBase64Url(result) !== value) {
    fail("invalid_value", "base64url value is not canonical");
  }
  return result;
}

export async function* asAsyncBytes(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      fail("invalid_argument", "byte source yielded a non-Uint8Array chunk");
    }
    if (chunk.byteLength > 0) yield chunk;
  }
}

export async function collectBytes(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of source) {
    length += part.byteLength;
    if (length > maximumBytes || !Number.isSafeInteger(length)) {
      fail("limit_exceeded", "collected byte stream exceeds its configured limit");
    }
    parts.push(part);
  }
  return concatBytes(parts);
}

export class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);
  #bufferOffset = 0;
  #closed = false;
  #ended = false;
  #position = 0n;

  constructor(source: ByteSource) {
    this.#iterator = asAsyncBytes(source)[Symbol.asyncIterator]();
  }

  get position(): bigint {
    return this.#position;
  }

  async readExactly(length: number, label = "archive"): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      fail("invalid_argument", "read length must be a non-negative safe integer");
    }
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.#bufferOffset === this.#buffer.byteLength) {
        await this.#fill();
        if (this.#ended) {
          throw new PortableArchiveError(
            "truncated_archive",
            `${label} ended before ${length} bytes could be read`,
          );
        }
      }
      const available = this.#buffer.byteLength - this.#bufferOffset;
      const count = Math.min(available, length - written);
      result.set(
        this.#buffer.subarray(this.#bufferOffset, this.#bufferOffset + count),
        written,
      );
      this.#bufferOffset += count;
      written += count;
      this.#position += BigInt(count);
    }
    return result;
  }

  async requireEnd(): Promise<void> {
    if (this.#bufferOffset < this.#buffer.byteLength) {
      fail("trailing_data", "archive contains bytes after its terminal record");
    }
    await this.#fill();
    if (!this.#ended) {
      fail("trailing_data", "archive contains bytes after its terminal record");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#ended = true;
    this.#buffer = new Uint8Array(0);
    this.#bufferOffset = 0;
    await this.#iterator.return?.();
  }

  async #fill(): Promise<void> {
    if (this.#ended || this.#bufferOffset < this.#buffer.byteLength) return;
    while (true) {
      const next = await this.#iterator.next();
      if (next.done) {
        this.#ended = true;
        this.#buffer = new Uint8Array(0);
        this.#bufferOffset = 0;
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        fail("invalid_argument", "byte source yielded a non-Uint8Array chunk");
      }
      if (next.value.byteLength === 0) continue;
      this.#buffer = next.value;
      this.#bufferOffset = 0;
      return;
    }
  }
}
