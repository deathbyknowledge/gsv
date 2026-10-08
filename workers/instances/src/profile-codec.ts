import { createHash } from "node:crypto";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { BrowserStorageError, MAX_PROFILE_BYTES } from "./browser-storage";

export const PROFILE_FORMAT = new Uint8Array([71, 83, 86, 2]);

/** JSON strings are escaped in bounded pieces, including paired/lone surrogates. */
function* json(value: JsonValue | undefined): Generator<string> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This codec serializes the explicit JSON value union.
  if (typeof value === "string") {
    yield '"';
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 16384, value.length);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1); offset = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) { if (i) yield ","; yield* json(value[i]); }
    yield "]";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The remaining JSON variant is an object or a primitive.
  } else if (value !== null && typeof value === "object") {
    yield "{"; let first = true;
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      if (!first) yield ","; first = false;
      yield* json(key); yield ":"; yield* json(value[key]);
    }
    yield "}";
  } else yield JSON.stringify(value ?? null);
}

export async function compressProfile(value: JsonValue, limit: number, signal?: AbortSignal): Promise<{ chunks: Uint8Array[]; compressedBytes: number; bytes: number; hash: string }> {
  const tokens = json(value), hash = createHash("sha256"), encoder = new TextEncoder();
  let bytes = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      signal?.throwIfAborted();
      const pieces: string[] = []; let size = 0, ended = false;
      while (size < 32768) {
        const next = tokens.next();
        if (next.done) { ended = true; break; }
        pieces.push(next.value); size += next.value.length;
      }
      if (size) {
        const chunk = encoder.encode(pieces.join("")); bytes += chunk.byteLength;
        if (bytes > limit) throw new BrowserStorageError(`Saved browser data exceeds the ${limit}-byte allowance`);
        hash.update(chunk); controller.enqueue(chunk);
      }
      if (ended) controller.close();
    },
    cancel() { tokens.return(undefined); },
  });
  const reader = source.pipeThrough(new CompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = []; let compressedBytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      chunks.push(next.value); compressedBytes += next.value.byteLength;
    }
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return { chunks, compressedBytes, bytes, hash: hash.digest("hex") };
}

/** Consumes compressed chunks so encryption never retains a second complete compressed copy. */
export async function encryptProfile(chunks: Uint8Array[], size: number, key: CryptoKey, iv: Uint8Array, address: string): Promise<ArrayBuffer> {
  const payload = new Uint8Array(PROFILE_FORMAT.length + size); payload.set(PROFILE_FORMAT);
  let offset = PROFILE_FORMAT.length;
  while (chunks.length) { const chunk = chunks.shift()!; payload.set(chunk, offset); offset += chunk.byteLength; }
  return crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) }, key, payload);
}

export async function decodeProfile(payload: Uint8Array): Promise<string> {
  if (!PROFILE_FORMAT.every((value, index) => payload[index] === value)) throw new Error("Unsupported saved browser format");
  const input = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(payload.subarray(PROFILE_FORMAT.length)); controller.close();
    payload = new Uint8Array();
  } });
  const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder(), text: string[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_PROFILE_BYTES) throw new Error("Saved browser data exceeds the restore size limit");
      text.push(decoder.decode(next.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
