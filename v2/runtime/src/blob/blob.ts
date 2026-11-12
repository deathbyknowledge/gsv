import { GsvFailure } from "@gsv/catalog";

/** Uploads move in parts of this size; it fits both R2 and S3-compatible stores. */
export const PART_BYTES = 32 * 1024 * 1024;

export type BlobBody = ReadableStream<Uint8Array> | ArrayBuffer;
export type MultipartUpload = {
  id: string;
  part(n: number, body: BlobBody): Promise<{ etag: string }>;
  complete(parts: { n: number; etag: string }[]): Promise<void>;
  abort(): Promise<void>;
};

/** The one storage interface for bytes. Objects are immutable once written. */
export interface BlobStore {
  put(key: string, body: BlobBody, opts?: { sha256?: string }): Promise<void>;
  get(key: string, range?: { offset: number; length?: number }): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<{ size: number; sha256?: string } | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>;
  multipart(key: string): Promise<MultipartUpload>;
  /** Continues an upload another request started. */
  resume(key: string, id: string): MultipartUpload;
}

/**
 * Both stores need a known length, so a body is read into memory, bounded by the part size.
 * Measuring a streamed length instead is on the spike's measurement list.
 */
export async function readBody(body: BlobBody): Promise<{ bytes: ArrayBuffer; sha256: string }> {
  let bytes: ArrayBuffer;
  if (body instanceof ArrayBuffer) bytes = body;
  else {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > PART_BYTES) throw new GsvFailure("too_large", "A blob body is at most one 32 MiB part; use a multipart upload.");
      chunks.push(chunk);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    bytes = joined.buffer;
  }
  if (bytes.byteLength > PART_BYTES) throw new GsvFailure("too_large", "A blob body is at most one 32 MiB part; use a multipart upload.");
  return { bytes, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) };
}

export function checkHash(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected.toLowerCase() !== actual) throw new GsvFailure("conflict", "The bytes don't match their hash.");
}

export function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
