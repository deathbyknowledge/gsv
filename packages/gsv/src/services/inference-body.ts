import type { AiTextMessage, AiTextTool } from "../protocol/syscalls/ai";
import * as z from "zod/mini";

export type InferenceContext = {
  systemPrompt?: string;
  messages: AiTextMessage[];
  tools?: AiTextTool[];
};

type ContextBody = { contentType: string; stream: ReadableStream<Uint8Array> };

/** Inline requests remain readable while receivers and callers roll forward. */
export type InferenceRequest<T extends InferenceContext> =
  | T
  | (Omit<T, keyof InferenceContext> & { contextBody: ContextBody });

// Admission still bounds model tokens and hydrated media independently. This
// bounds the multipart parser, including text, before it allocates a full body.
export const MAX_INFERENCE_CONTEXT_BYTES = 64 * 1024 * 1024;
const BASE64_CHUNK = 64 * 1024;
const contentTypeSchema = z.string().check(z.regex(/^multipart\/form-data;\s*boundary=[^;\r\n]{1,200}$/i));

/**
 * RPC carries only identity, controls and a byte stream. Image parts are binary;
 * base64 is reconstructed only for the provider-facing model-context contract.
 */
export function encodeInferenceRequest<T extends InferenceContext>(
  input: T,
): Omit<T, keyof InferenceContext> & { contextBody: ContextBody } {
  const { systemPrompt, messages, tools, ...metadata } = input;
  const boundary = `gsv-inference-${crypto.randomUUID()}`;
  const parts: BlobPart[] = [];
  const imageHeader = (name: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="image"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  // SAFETY: Each message keeps its role and fields; only image data is replaced
  // by an empty string while the corresponding bytes travel in a named part.
  const context: InferenceContext = {
    systemPrompt,
    tools,
    messages: messages.map((message, messageIndex) => !Array.isArray(message.content)
      ? message
      : {
        ...message,
        content: message.content.map((block, blockIndex) => {
          if (block.type !== "image") return block;
          const image: Uint8Array<ArrayBuffer>[] = [];
          for (let offset = 0; offset < block.data.length; offset += BASE64_CHUNK) {
            const decoded = atob(block.data.slice(offset, offset + BASE64_CHUNK));
            const bytes = new Uint8Array(decoded.length);
            for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
            image.push(bytes);
          }
          parts.push(imageHeader(`image:${messageIndex}:${blockIndex}`), new Blob(image), "\r\n");
          return { ...block, data: "" };
        }),
      } as AiTextMessage),
  };
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="context"\r\n\r\n`,
    JSON.stringify(context), `\r\n--${boundary}--\r\n`);
  // A Blob streams on demand. Response(FormData) eagerly buffers parts in some
  // runtimes and can keep enqueueing after an unconsumed request is cancelled.
  const body = new Blob(parts);
  if (body.size > MAX_INFERENCE_CONTEXT_BYTES) throw new Error("Inference context body exceeds its byte limit");
  return {
    ...metadata,
    contextBody: {
      contentType: `multipart/form-data; boundary=${boundary}`,
      stream: boundedBody(body.stream()),
    },
  };
}

/**
 * Call after claiming the request and checking its installation and controls.
 * The owning request's signal must cover upload as well as provider execution.
 */
export async function decodeInferenceRequest<T extends InferenceContext>(
  input: InferenceRequest<T>,
  signal?: AbortSignal,
): Promise<T>;
export async function decodeInferenceRequest(
  input: InferenceRequest<InferenceContext>,
  signal?: AbortSignal,
): Promise<InferenceContext> {
  if (!(input instanceof Object)) throw new Error("Invalid inference request");
  if (!("contextBody" in input)) return input;
  const { contextBody, ...metadata } = input;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    signal?.throwIfAborted();
    if (!contextBody || !contentTypeSchema.safeParse(contextBody.contentType).success
      || !(contextBody.stream instanceof ReadableStream)) {
      throw new Error("Invalid inference context body");
    }
    const headers = new Headers({ "content-type": contextBody.contentType });
    body = boundedBody(contextBody.stream, signal);
    const form = await new Response(body, { headers }).formData();
    signal?.throwIfAborted();
    const encoded = form.get("context");
    if (encoded === null || encoded instanceof Blob || form.getAll("context").length !== 1) {
      throw new Error("Inference context is missing");
    }
    let context: InferenceContext;
    try {
      // SAFETY: Only the context fields below are selected; identity, credentials,
      // limits and deadlines can never be supplied by the body.
      context = JSON.parse(encoded) as InferenceContext;
    } catch {
      throw new Error("Invalid inference context JSON");
    }
    if (!context || !Array.isArray(context.messages)
      || !z.optional(z.string()).safeParse(context.systemPrompt).success
      || (context.tools !== undefined && !Array.isArray(context.tools))) {
      throw new Error("Invalid inference context");
    }
    form.delete("context");
    for (const [messageIndex, message] of context.messages.entries()) {
      if (!message || !["user", "assistant", "toolResult"].includes(message.role)) {
        throw new Error("Invalid inference message");
      }
      if (z.string().safeParse(message.content).success && message.role === "user") continue;
      if (!Array.isArray(message.content)) throw new Error("Invalid inference message content");
      for (const [blockIndex, block] of message.content.entries()) {
        if (!block || !z.string().safeParse(block.type).success) throw new Error("Invalid inference content block");
        if (block.type !== "image") continue;
        const key = `image:${messageIndex}:${blockIndex}`;
        const file = form.get(key);
        if (block.data !== "" || !(file instanceof Blob) || form.getAll(key).length !== 1) {
          throw new Error("Invalid inference image body");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        signal?.throwIfAborted();
        const parts: string[] = [];
        // A multiple of three keeps each chunk's base64 padding at the end only.
        for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
          parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 48 * 1024))));
        }
        block.data = parts.join("");
        form.delete(key);
      }
    }
    form.forEach(() => { throw new Error("Unexpected inference body part"); });
    return {
      ...metadata,
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools,
    };
  } catch (error) {
    cancelInferenceRequest(input, error instanceof Error ? error : undefined);
    throw error;
  } finally {
    // Parsing or header validation may fail before the body has been consumed.
    // Cancel the wrapper that owns the reader, not its now-locked source.
    if (body && !body.locked) void body.cancel().catch(() => {});
  }
}

export function cancelInferenceRequest<T extends InferenceContext>(
  input: InferenceRequest<T>,
  reason?: Error,
): void {
  if (input instanceof Object && "contextBody" in input && input.contextBody?.stream instanceof ReadableStream
    && !input.contextBody.stream.locked) {
    void input.contextBody.stream.cancel(reason).catch(() => {});
  }
}

/** Bound bytes before multipart parsing and cancel its source on every exit. */
function boundedBody(source: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let bytes = 0;
  let closed = false;
  let controller: ReadableByteStreamController;
  const cleanup = (reason?: Error) => {
    signal?.removeEventListener("abort", abort);
    void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  };
  const abort = () => {
    if (closed) return;
    closed = true;
    cleanup(signal?.reason);
    controller.error(signal?.reason ?? new DOMException("Inference context cancelled", "AbortError"));
  };
  return new ReadableStream({
    type: "bytes",
    start(value) {
      controller = value;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull() {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          signal?.removeEventListener("abort", abort);
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)
          || (bytes += next.value.byteLength) > MAX_INFERENCE_CONTEXT_BYTES) {
          throw new Error("Inference context body exceeds its byte limit");
        }
        // Byte streams transfer buffers. Do not detach the multipart source's
        // reusable backing storage or another chunk sharing that storage.
        controller.enqueue(next.value.slice());
      } catch (error) {
        if (closed) return;
        closed = true;
        cleanup(error instanceof Error ? error : undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      cleanup(reason);
    },
  });
}
