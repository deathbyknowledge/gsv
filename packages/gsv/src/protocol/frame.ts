import * as z from "zod/mini";
import type { BinaryFrameDescriptor } from "./binary-frame";
import { binaryBodySchema, type BinaryBody } from "./body";
import { jsonValueSchema, type JsonValue } from "./json";

/** Structured failure carried by an error response on every carrier. */
export type FrameError = {
  code: number;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
};

/** A table of call names to their argument and result contracts. */
export type SyscallTable = { [call: string]: { args: unknown; result: unknown } };

/**
 * Frame envelopes shared by every carrier. `Body` is how the carrier represents
 * attached bytes: a `BinaryFrameDescriptor` on the WebSocket wire, a `BinaryBody`
 * in memory and across Workers RPC.
 */
export type RequestEnvelope<Body, Call extends string = string, Args = JsonValue> = {
  type: "req";
  id: string;
  call: Call;
  args: Args;
  runId?: string;
  body?: Body;
};

export type ResponseOkEnvelope<Body, Data = JsonValue> = {
  type: "res";
  id: string;
  ok: true;
  data?: Data;
  body?: Body;
};

export type ResponseErrEnvelope = {
  type: "res";
  id: string;
  ok: false;
  error: FrameError;
};

export type ResponseEnvelope<Body, Data = JsonValue> =
  | ResponseOkEnvelope<Body, Data>
  | ResponseErrEnvelope;

export type SignalEnvelope<Payload = JsonValue> = {
  type: "sig";
  signal: string;
  payload?: Payload;
  seq?: number;
};

export type FrameEnvelope<Body> = RequestEnvelope<Body> | ResponseEnvelope<Body> | SignalEnvelope;

/** Request and response envelopes typed by one call of a syscall table. */
export type TypedRequest<T extends SyscallTable, S extends keyof T & string, Body> = {
  [K in S]: RequestEnvelope<Body, K, T[K]["args"]>;
}[S];

export type TypedResponseOk<T extends SyscallTable, S extends keyof T & string, Body> =
  ResponseOkEnvelope<Body, T[S]["result"]>;

export type TypedResponse<T extends SyscallTable, S extends keyof T & string, Body> =
  | TypedResponseOk<T, S, Body>
  | ResponseErrEnvelope;

export const frameErrorSchema = z.strictObject({
  code: z.number(),
  message: z.string(),
  details: z.optional(jsonValueSchema),
  retryable: z.optional(z.boolean()),
});

export const binaryFrameDescriptorSchema: z.ZodMiniType<BinaryFrameDescriptor> = z.strictObject({
  streamId: z.int().check(z.positive()),
  length: z.optional(z.int().check(z.nonnegative())),
});

/**
 * Envelope schemas for one carrier's body representation. Arguments, results,
 * and payloads stay JSON here; syscall contracts are validated separately.
 */
export function frameEnvelopeSchemas<BodySchema extends z.ZodMiniType>(bodySchema: BodySchema) {
  const request = z.strictObject({
    type: z.literal("req"),
    id: z.string(),
    call: z.string(),
    args: jsonValueSchema,
    runId: z.optional(z.string()),
    body: z.optional(bodySchema),
  });
  const responseOk = z.strictObject({
    type: z.literal("res"),
    id: z.string(),
    ok: z.literal(true),
    data: z.optional(jsonValueSchema),
    body: z.optional(bodySchema),
  });
  const responseErr = z.strictObject({
    type: z.literal("res"),
    id: z.string(),
    ok: z.literal(false),
    error: frameErrorSchema,
  });
  const response = z.discriminatedUnion("ok", [responseOk, responseErr]);
  const signal = z.strictObject({
    type: z.literal("sig"),
    signal: z.string(),
    payload: z.optional(jsonValueSchema),
    seq: z.optional(z.number()),
  });
  const frame = z.union([request, response, signal]);
  return { request, responseOk, responseErr, response, signal, frame };
}

/** JSON wire frames whose bodies are binary stream descriptors. */
export const wireFrameSchemas = frameEnvelopeSchemas(binaryFrameDescriptorSchema);

/** In-memory and Workers RPC frames whose bodies are byte streams. */
export const bodyFrameSchemas = frameEnvelopeSchemas(binaryBodySchema);

export type BodyFrame = FrameEnvelope<BinaryBody>;
