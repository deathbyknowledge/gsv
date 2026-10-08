import * as z from "zod/mini";
import type { BinaryBody } from "./body";
import type { BrowserHandoff, BrowserPointer } from "./syscalls/instance";

export type BrowserViewFrame = {
  kind: "frame";
  sequence: number;
  capturedAt: number;
  tabId: number;
  documentId: string;
  width: number;
  height: number;
};
export type BrowserViewState = {
  kind: "state";
  tabs: Array<{ id: number; title: string; url: string }>;
  activeTabId: number;
  pointer?: BrowserPointer;
  handoff?: BrowserHandoff;
};
export type BrowserViewMetadata = BrowserViewFrame | BrowserViewState;
export type BrowserViewPacket = { metadata: BrowserViewMetadata; image: Uint8Array };

const integer = z.number().check(z.int(), z.nonnegative());
const positive = z.number().check(z.int(), z.positive());
const text = z.string().check(z.maxLength(16384));
const metadataSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("frame"), sequence: positive, capturedAt: integer, tabId: positive,
    documentId: text, width: positive, height: positive }),
  z.strictObject({ kind: z.literal("state"), activeTabId: integer,
    tabs: z.array(z.strictObject({ id: positive, title: text, url: text })),
    pointer: z.optional(z.strictObject({ tabId: positive, x: z.number(), y: z.number(), actor: z.enum(["ship", "human"]), clickedAt: z.optional(integer) })),
    handoff: z.optional(z.strictObject({ requestId: text, instanceId: text, tabId: positive, activeTabId: z.optional(positive),
      purpose: text, site: text, state: z.enum(["pending", "active", "completed", "cancelled", "expired", "failed"]),
      revision: integer, createdAt: integer, expiresAt: integer, responsibilityId: z.optional(text),
      completedAt: z.optional(integer), reason: z.optional(text), diagnosticRef: z.optional(text) })),
  }),
]);
const MAX_METADATA_BYTES = 256 * 1024;
export const MAX_BROWSER_IMAGE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });

/** Records survive arbitrary RPC and WebSocket chunk boundaries; images are raw JPEG bytes. */
export function encodeBrowserViewPacket(metadata: BrowserViewMetadata, image: Uint8Array = new Uint8Array()): Uint8Array {
  const json = encoder.encode(JSON.stringify(metadata));
  validateLengths(json.length, image.length);
  if ((metadata.kind === "frame") !== (image.length > 0)) throw new Error("Browser frame must contain an image");
  const bytes = new Uint8Array(8 + json.length + image.length);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, json.length, true);
  header.setUint32(4, image.length, true);
  bytes.set(json, 8); bytes.set(image, 8 + json.length);
  return bytes;
}

export async function* decodeBrowserViewStream(body: BinaryBody, signal?: AbortSignal): AsyncGenerator<BrowserViewPacket> {
  const reader = body.stream.getReader();
  let chunk: Uint8Array = new Uint8Array(), offset = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const read = async (length: number, allowEnd = false): Promise<Uint8Array | null> => {
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      signal?.throwIfAborted();
      if (offset === chunk.length) {
        const value = await reader.read();
        signal?.throwIfAborted();
        if (value.done) {
          if (allowEnd && filled === 0) return null;
          throw new Error("Browser view ended inside a frame");
        }
        chunk = value.value; offset = 0;
      }
      const count = Math.min(length - filled, chunk.length - offset);
      bytes.set(chunk.subarray(offset, offset + count), filled);
      filled += count; offset += count;
    }
    return bytes;
  };
  try {
    while (true) {
      const prefix = await read(8, true);
      if (!prefix) return;
      const header = new DataView(prefix.buffer);
      const metadataLength = header.getUint32(0, true), imageLength = header.getUint32(4, true);
      validateLengths(metadataLength, imageLength);
      const metadata = metadataSchema.parse(JSON.parse(decoder.decode((await read(metadataLength))!)));
      if ((metadata.kind === "frame") !== (imageLength > 0)) throw new Error("Browser frame must contain an image");
      yield { metadata, image: (await read(imageLength))! };
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel("Browser view closed").catch(() => {});
    reader.releaseLock();
  }
}

function validateLengths(metadataLength: number, imageLength: number): void {
  if (metadataLength < 1 || metadataLength > MAX_METADATA_BYTES || imageLength > MAX_BROWSER_IMAGE_BYTES) {
    throw new Error("Browser view record exceeds its size limit");
  }
}
