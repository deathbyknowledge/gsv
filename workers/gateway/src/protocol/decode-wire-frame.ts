import { Validator } from "@cfworker/json-schema";
import type {
  JsonValue,
  SyscallName,
  WireFrame,
  WireResponseEnvelope,
  WireResponseFrame,
} from "@humansandmachines/gsv/protocol";
import { wireFrameSchemas } from "@humansandmachines/gsv/protocol";
import {
  wireProtocolSchema,
  wireRequestSchemaRefs,
  wireResponseSchemaRefs,
} from "./generated/wire-frame-schema.js";
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
  const decoded = wireFrameSchemas.frame.safeParse(value);
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
