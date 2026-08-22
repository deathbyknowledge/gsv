import type { ManagedInferenceStreamEvent } from "./managed";
import { GSV_INFERENCE_PRODUCT_MODEL, GSV_INFERENCE_PROVIDER } from "./managed";
import { jsonObjectSchema } from "./json";
import * as z from "zod/mini";

export const MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const nonNegativeIntegerSchema = z.number().check(z.int(), z.nonnegative());
const nonNegativeNumberSchema = z.number().check(z.nonnegative());
const textContentSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.optional(z.string()),
});
const thinkingContentSchema = z.strictObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.optional(z.string()),
  redacted: z.optional(z.boolean()),
});
const toolCallSchema = z.strictObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: jsonObjectSchema,
  thoughtSignature: z.optional(z.string()),
});
const contentSchema = z.discriminatedUnion("type", [
  textContentSchema,
  thinkingContentSchema,
  toolCallSchema,
]);
const usageSchema = z.strictObject({
  input: nonNegativeIntegerSchema,
  output: nonNegativeIntegerSchema,
  cacheRead: nonNegativeIntegerSchema,
  cacheWrite: nonNegativeIntegerSchema,
  cacheWrite1h: z.optional(nonNegativeIntegerSchema),
  totalTokens: nonNegativeIntegerSchema,
  cost: z.strictObject({
    input: nonNegativeNumberSchema,
    output: nonNegativeNumberSchema,
    cacheRead: nonNegativeNumberSchema,
    cacheWrite: nonNegativeNumberSchema,
    total: nonNegativeNumberSchema,
  }),
});
const managedMessageFields = {
  role: z.literal("assistant"),
  content: z.array(contentSchema),
  api: z.literal("gsv-inference"),
  provider: z.literal(GSV_INFERENCE_PROVIDER),
  model: z.literal(GSV_INFERENCE_PRODUCT_MODEL),
  responseModel: z.optional(z.string()),
  responseId: z.optional(z.string()),
  usage: usageSchema,
  errorMessage: z.optional(z.string()),
  timestamp: nonNegativeIntegerSchema,
};
const managedInferenceResultSchema = z.strictObject({
  ...managedMessageFields,
  stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
});
const managedInferencePartialSchema = z.strictObject({
  ...managedMessageFields,
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted"]),
});

export const managedInferenceStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), partial: managedInferencePartialSchema }),
  z.strictObject({
    type: z.literal("text_start"),
    contentIndex: nonNegativeIntegerSchema,
    content: textContentSchema,
  }),
  z.strictObject({
    type: z.literal("text_delta"),
    contentIndex: nonNegativeIntegerSchema,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("text_end"),
    contentIndex: nonNegativeIntegerSchema,
    content: textContentSchema,
  }),
  z.strictObject({
    type: z.literal("thinking_start"),
    contentIndex: nonNegativeIntegerSchema,
    content: thinkingContentSchema,
  }),
  z.strictObject({
    type: z.literal("thinking_delta"),
    contentIndex: nonNegativeIntegerSchema,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("thinking_end"),
    contentIndex: nonNegativeIntegerSchema,
    content: thinkingContentSchema,
  }),
  z.strictObject({
    type: z.literal("toolcall_start"),
    contentIndex: nonNegativeIntegerSchema,
    toolCall: toolCallSchema,
  }),
  z.strictObject({
    type: z.literal("toolcall_delta"),
    contentIndex: nonNegativeIntegerSchema,
    delta: z.string(),
    toolCall: toolCallSchema,
  }),
  z.strictObject({
    type: z.literal("toolcall_end"),
    contentIndex: nonNegativeIntegerSchema,
    toolCall: toolCallSchema,
  }),
  z.strictObject({
    type: z.literal("done"),
    reason: z.enum(["stop", "length", "toolUse"]),
    message: managedInferenceResultSchema,
  }).check(z.refine((event) => event.message.stopReason === event.reason)),
  z.strictObject({
    type: z.literal("error"),
    reason: z.enum(["error", "aborted"]),
    error: managedInferenceResultSchema,
  }).check(z.refine((event) => event.error.stopReason === event.reason)),
]);

export function encodeManagedInferenceStreamEvent(
  event: ManagedInferenceStreamEvent,
): Uint8Array {
  const payload = encoder.encode(JSON.stringify(event));
  if (payload.byteLength > MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES) {
    throw new Error("Managed inference stream event is too large");
  }
  const framed = new Uint8Array(payload.byteLength + 1);
  framed.set(payload);
  framed[payload.byteLength] = 0x0a;
  return framed;
}

export async function* decodeManagedInferenceStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ManagedInferenceStreamEvent> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let eventBytes = 0;
  let completed = false;
  const cancelForAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelForAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Managed inference stream emitted a non-byte chunk");
      }
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        appendPart(value.subarray(start, index), parts, eventBytes);
        eventBytes += index - start;
        if (eventBytes === 0) {
          throw new Error("Managed inference stream emitted an empty event");
        }
        yield parseEvent(parts, eventBytes);
        parts.length = 0;
        eventBytes = 0;
        start = index + 1;
      }
      const remainder = value.subarray(start);
      appendPart(remainder, parts, eventBytes);
      eventBytes += remainder.byteLength;
    }
    if (eventBytes !== 0) {
      throw new Error("Managed inference stream ended with an incomplete event");
    }
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function appendPart(
  part: Uint8Array,
  parts: Uint8Array[],
  previousBytes: number,
): void {
  if (previousBytes + part.byteLength > MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES) {
    throw new Error("Managed inference stream event is too large");
  }
  if (part.byteLength > 0) parts.push(part);
}

function parseEvent(parts: Uint8Array[], byteLength: number): ManagedInferenceStreamEvent {
  const payload = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.byteLength;
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new Error("Managed inference stream event is not UTF-8");
  }
  let decoded: Parameters<typeof managedInferenceStreamEventSchema.safeParse>[0];
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new Error("Managed inference stream event is not valid JSON");
  }
  const parsed = managedInferenceStreamEventSchema.safeParse(decoded);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "event"}: ${issue.code}`)
      .join(", ");
    throw new Error(`Managed inference stream event does not match the protocol (${issues})`);
  }
  return parsed.data;
}

function abortError(): Error {
  return new DOMException("Managed inference stream was aborted", "AbortError");
}
