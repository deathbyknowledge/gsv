import * as z from "zod/mini";

export type BinaryBody = {
  stream: ReadableStream<Uint8Array>;
  length?: number;
};

const binaryBodyObjectSchema = z.strictObject({
  stream: z.instanceof(ReadableStream),
  length: z.optional(z.number()),
});

/** Validates a transferred body without replacing its identity or stream. */
export const binaryBodySchema = z.custom<BinaryBody>(
  (value) => binaryBodyObjectSchema.safeParse(value).success,
);

const MAX_PREALLOCATED_BODY_BYTES = 64 * 1024 * 1024;

export const BODY_SYSCALL_NAMES = [
  "fs.read",
  "fs.transfer.send",
  "fs.transfer.receive",
  "net.fetch",
  "proc.media.read",
  "conversation.media.read",
  "proc.media.write",
  "ai.transcription.create",
  "ai.image.read",
  "ai.image.generate",
  "ai.speech.create",
  "adapter.inbound",
  "adapter.send",
] as const;

export type BodySyscallName = typeof BODY_SYSCALL_NAMES[number];

export function bodyFromBytes(bytes: Uint8Array): BinaryBody {
  const length = bytes.byteLength;
  const chunk = new Uint8Array(length);
  chunk.set(bytes);
  const source: UnderlyingByteSource = {
    type: "bytes",
    start(controller) {
      if (chunk.byteLength > 0) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  };
  return { stream: new ReadableStream(source), length };
}

export function bodyFromText(text: string): BinaryBody {
  return bodyFromBytes(new TextEncoder().encode(text));
}

export async function bodyToBytes(
  body: BinaryBody,
  maxBytes = Infinity,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (body.length !== undefined && body.length > maxBytes) {
    await body.stream.cancel().catch(() => {});
    throw new Error(`Body exceeds limit (${body.length} bytes, max ${maxBytes})`);
  }

  const reader = body.stream.getReader();
  const chunks: Uint8Array[] = [];
  const fixed = Number.isFinite(maxBytes)
    && body.length !== undefined
    && Number.isSafeInteger(body.length)
    && body.length >= 0
    && body.length <= maxBytes
    && body.length <= MAX_PREALLOCATED_BODY_BYTES
    ? new Uint8Array(body.length)
    : null;
  let length = 0;
  let aborted: Error | null = null;
  const abort = () => {
    aborted ??= signal?.reason instanceof Error
      ? signal.reason
      : new Error("Body read cancelled");
    void reader.cancel(aborted).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Body exceeds limit (${length} bytes, max ${maxBytes})`);
      }
      if (fixed) {
        if (length > fixed.byteLength) {
          await reader.cancel().catch(() => {});
          throw new Error(`Body length ${length} did not match ${body.length}`);
        }
        fixed.set(value, length - value.byteLength);
      } else {
        chunks.push(value);
      }
    }
    if (aborted) {
      throw aborted;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  if (body.length !== undefined && length !== body.length) {
    throw new Error(`Body length ${length} did not match ${body.length}`);
  }
  if (fixed) return fixed;
  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0];
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function bodyToText(
  body: BinaryBody,
  maxBytes = Infinity,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await bodyToBytes(body, maxBytes, signal));
}
