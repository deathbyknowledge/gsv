import { Validator } from "@cfworker/json-schema";
import type {
  JsonValue,
  SyscallName,
  WireFrame,
  WireResponseEnvelope,
  WireResponseFrame,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import {
  wireProtocolSchema,
  wireRequestSchemaRefs,
  wireResponseSchemaRefs,
} from "./generated/wire-frame-schema.js";

const jsonValueSchema = z.json();
const binaryBodySchema = z.object({
  streamId: z.number(),
  length: z.number().optional(),
}).strict();
const requestEnvelopeSchema = z.object({
  type: z.literal("req"),
  id: z.string(),
  call: z.string(),
  args: jsonValueSchema,
  runId: z.string().optional(),
  body: binaryBodySchema.optional(),
}).strict();
const responseEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("res"),
    id: z.string(),
    ok: z.literal(true),
    data: jsonValueSchema.optional(),
    body: binaryBodySchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("res"),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({
      code: z.number(),
      message: z.string(),
      details: jsonValueSchema.optional(),
      retryable: z.boolean().optional(),
    }).strict(),
  }).strict(),
]);
const signalEnvelopeSchema = z.object({
  type: z.literal("sig"),
  signal: z.string(),
  payload: jsonValueSchema.optional(),
  seq: z.number().optional(),
}).strict();
const frameEnvelopeSchema = z.union([
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  signalEnvelopeSchema,
]);
const validators = new Map<string, Validator>();

export class InvalidWireFrameError extends Error {
  constructor(message: string, readonly frameId = "?") {
    super(message);
    this.name = "InvalidWireFrameError";
  }
}

export function decodeWireFrameJson(source: string): WireFrame {
  let value: JsonValue;
  try {
    value = JSON.parse(source);
  } catch {
    throw new InvalidWireFrameError("Malformed JSON");
  }
  const decoded = frameEnvelopeSchema.safeParse(value);
  if (!decoded.success) {
    throw new InvalidWireFrameError("Invalid frame");
  }
  const frame = decoded.data;
  if (frame.type !== "req") return frame;

  const schemaRef = wireRequestSchemaRefs.get(frame.call);
  if (!schemaRef || !validateWithGeneratedSchema(schemaRef, frame)) {
    throw new InvalidWireFrameError(`Invalid ${frame.call} arguments`, frame.id);
  }
  // SAFETY: The generated schema branch is derived from WireRequestFrame for this exact call.
  return frame as WireFrame;
}

export function decodeWireResponse<S extends SyscallName>(
  call: S,
  frame: WireResponseEnvelope,
): WireResponseFrame<S> {
  const routedResponse = { call, frame };
  const schemaRef = wireResponseSchemaRefs.get(call);
  if (!schemaRef || !validateWithGeneratedSchema(schemaRef, routedResponse)) {
    throw new InvalidWireFrameError(`Invalid ${call} response`);
  }
  // SAFETY: The generated schema branch pairs this exact call with WireResponseFrame<S>.
  return routedResponse.frame as WireResponseFrame<S>;
}

function validateWithGeneratedSchema(schemaRef: string, value: JsonValue): boolean {
  let validator = validators.get(schemaRef);
  if (!validator) {
    validator = new Validator({ $ref: schemaRef }, "7");
    validator.addSchema(wireProtocolSchema);
    validators.set(schemaRef, validator);
  }
  return validator.validate(value).valid;
}
