import {
  Message,
  Struct,
  Text,
  utils,
} from "capnp-es";
import {
  BodyDescriptor as CapnpBodyDescriptor,
  BodyDescriptor_Length_Which,
  JsonEntry,
  JsonValue as CapnpJsonValue,
  JsonValue_Which,
  Request,
  Response,
  ResponseFailure,
  ResponseSuccess,
  Response_Which,
  Signal,
  Signal_Seq_Which,
  WireError_Retryable_Which,
  WireFrame,
  WireFrame_Which,
} from "../generated/current/wire-frame";
import type {
  BodyDescriptor,
  ControlFrame,
  JsonValue,
} from "./types";

export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
export const MAX_CONTROL_SEGMENTS = 16;
export const MAX_CONTROL_NESTING = 64;
export const MAX_CONTROL_POINTERS = 65_536;
export const V4_BINARY_HEADER_BYTES = 5;
export const V4_CONTROL_STREAM_ID = 0;
export const V4_CONTROL_UNPACKED = 0;
export const V4_CONTROL_PACKED = 1;

type DecodeLimits = {
  maxBytes?: number;
  maxSegments?: number;
  maxNesting?: number;
  maxPointers?: number;
};

type ResolvedLimits = {
  maxBytes: number;
  maxSegments: number;
  maxNesting: number;
  maxPointers: number;
};

type DecodeBudget = {
  remainingNodes: number;
  maxNesting: number;
};

export type V4BinaryMessage =
  | {
      kind: "control";
      frame: ControlFrame;
      packed: boolean;
    }
  | {
      kind: "body";
      streamId: number;
      flags: number;
      payload: Uint8Array;
    };

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class InvalidCapnpControlFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCapnpControlFrameError";
  }
}

export function encodeControlFrame(
  frame: ControlFrame,
  options: { packed?: boolean } = {},
): ArrayBuffer {
  const message = new Message();
  const root = message.initRoot(WireFrame);
  const budget: DecodeBudget = {
    remainingNodes: MAX_CONTROL_POINTERS,
    maxNesting: MAX_CONTROL_NESTING,
  };

  switch (frame.type) {
    case "req":
      writeRequest(frame, root._initRequest(), budget);
      break;
    case "res":
      writeResponse(frame, root._initResponse(), budget);
      break;
    case "sig":
      writeSignal(frame, root._initSignal(), budget);
      break;
  }

  const encoded = options.packed
    ? message.toPackedArrayBuffer()
    : message.toArrayBuffer();
  if (encoded.byteLength > MAX_CONTROL_FRAME_BYTES) {
    throw invalid("Encoded control frame exceeds byte limit");
  }
  return encoded;
}

export function decodeControlFrame(
  source: ArrayBuffer | ArrayBufferView,
  options: DecodeLimits & { packed?: boolean } = {},
): ControlFrame {
  const limits = resolveLimits(options);
  const sourceBuffer = exactArrayBuffer(source);
  const unpacked = options.packed
    ? unpackBounded(sourceBuffer, limits.maxBytes)
    : sourceBuffer;
  validateUnpackedMessage(unpacked, limits);

  try {
    const message = new Message(unpacked, false);
    message._capnp.traversalLimit = limits.maxPointers * 8;
    const root = message.getRoot(WireFrame);
    root._capnp.depthLimit = limits.maxNesting;
    return readFrame(root, {
      remainingNodes: limits.maxPointers,
      maxNesting: limits.maxNesting,
    });
  } catch (error) {
    if (error instanceof InvalidCapnpControlFrameError) throw error;
    throw new InvalidCapnpControlFrameError(
      error instanceof Error && error.message ? error.message : "Invalid Cap'n Proto frame",
    );
  }
}

export function encodeV4ControlMessage(
  frame: ControlFrame,
  options: { packed?: boolean } = {},
): ArrayBuffer {
  const payload = new Uint8Array(encodeControlFrame(frame, options));
  const message = new Uint8Array(V4_BINARY_HEADER_BYTES + payload.byteLength);
  new DataView(message.buffer).setUint8(
    4,
    options.packed ? V4_CONTROL_PACKED : V4_CONTROL_UNPACKED,
  );
  message.set(payload, V4_BINARY_HEADER_BYTES);
  return message.buffer;
}

export function decodeV4BinaryMessage(
  source: ArrayBuffer | ArrayBufferView,
  limits: DecodeLimits = {},
): V4BinaryMessage {
  const bytes = exactBytes(source);
  if (bytes.byteLength < V4_BINARY_HEADER_BYTES) throw invalid("Truncated v4 binary header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(0, true);
  const flags = view.getUint8(4);
  const payload = bytes.subarray(V4_BINARY_HEADER_BYTES);
  if (streamId !== V4_CONTROL_STREAM_ID) {
    return { kind: "body", streamId, flags, payload };
  }
  if (flags !== V4_CONTROL_UNPACKED && flags !== V4_CONTROL_PACKED) {
    throw invalid("Unknown v4 control encoding");
  }
  const packed = flags === V4_CONTROL_PACKED;
  return {
    kind: "control",
    frame: decodeControlFrame(payload, { ...limits, packed }),
    packed,
  };
}

export function openRawSingleSegmentForProbe(segment: ArrayBuffer): WireFrame {
  if (segment.byteLength < 8 || segment.byteLength % 8 !== 0) {
    throw new InvalidCapnpControlFrameError("Invalid raw segment size");
  }
  const message = new Message(segment, false, true);
  message._capnp.traversalLimit = MAX_CONTROL_POINTERS * 8;
  const root = message.getRoot(WireFrame);
  root._capnp.depthLimit = MAX_CONTROL_NESTING;
  return root;
}

export function firstSegmentCopy(message: ArrayBuffer): ArrayBuffer {
  const limits = resolveLimits({});
  validateUnpackedMessage(message, limits);
  const segmentCount = new DataView(message).getUint32(0, true) + 1;
  const headerBytes = alignToWord(4 + segmentCount * 4);
  const firstWords = new DataView(message).getUint32(4, true);
  return message.slice(headerBytes, headerBytes + firstWords * 8);
}

function writeRequest(
  frame: Extract<ControlFrame, { type: "req" }>,
  target: Request,
  budget: DecodeBudget,
): void {
  target.id = validText(frame.id, "request id");
  target.call = validText(frame.call, "request call");
  writeJson(frame.args, target._initArgs(), budget, 0);
  if (frame.runId !== undefined) target.runId = validText(frame.runId, "run id");
  if (frame.body !== undefined) writeBody(frame.body, target._initBody());
}

function writeResponse(
  frame: Extract<ControlFrame, { type: "res" }>,
  target: Response,
  budget: DecodeBudget,
): void {
  target.id = validText(frame.id, "response id");
  if (frame.ok) {
    const success = target._initSuccess();
    if (frame.data !== undefined) {
      writeJson(frame.data, success._initData(), budget, 0);
    }
    if (frame.body !== undefined) writeBody(frame.body, success._initBody());
    return;
  }

  const failure = target._initFailure();
  const error = failure._initError();
  assertFinite(frame.error.code, "error code");
  error.code = frame.error.code;
  error.message = validText(frame.error.message, "error message");
  if (frame.error.details !== undefined) {
    writeJson(frame.error.details, error._initDetails(), budget, 0);
  }
  if (frame.error.retryable !== undefined) {
    error.retryable.value = frame.error.retryable;
  }
}

function writeSignal(
  frame: Extract<ControlFrame, { type: "sig" }>,
  target: Signal,
  budget: DecodeBudget,
): void {
  target.signal = validText(frame.signal, "signal name");
  if (frame.payload !== undefined) {
    writeJson(frame.payload, target._initPayload(), budget, 0);
  }
  if (frame.seq !== undefined) {
    assertFinite(frame.seq, "signal sequence");
    target.seq.value = frame.seq;
  }
}

function writeBody(body: BodyDescriptor, target: CapnpBodyDescriptor): void {
  if (!Number.isSafeInteger(body.streamId) || body.streamId <= 0 || body.streamId > 0xffff_ffff) {
    throw new InvalidCapnpControlFrameError("Invalid body stream id");
  }
  target.streamId = body.streamId;
  if (body.length !== undefined) {
    if (!Number.isSafeInteger(body.length) || body.length < 0) {
      throw new InvalidCapnpControlFrameError("Invalid body length");
    }
    target.length.value = BigInt(body.length);
  }
}

function writeJson(
  value: JsonValue,
  target: CapnpJsonValue,
  budget: DecodeBudget,
  depth: number,
): void {
  consumeBudget(budget, depth);
  if (value === null) {
    target.nullValue = true;
    return;
  }
  if (isBoolean(value)) {
    target.boolValue = value;
    return;
  }
  if (isNumber(value)) {
    assertFinite(value, "JSON number");
    target.numberValue = value;
    return;
  }
  if (isString(value)) {
    target.stringValue = validText(value, "JSON string");
    return;
  }
  if (Array.isArray(value)) {
    const list = target._initArrayValue(value.length);
    for (let index = 0; index < value.length; index++) {
      writeJson(value[index], list.get(index), budget, depth + 1);
    }
    return;
  }
  writeJsonObject(value, target, budget, depth);
}

function isBoolean(value: JsonValue): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: JsonValue): value is number {
  return typeof value === "number";
}

function isString(value: JsonValue): value is string {
  return typeof value === "string";
}

function writeJsonObject(
  value: { [key: string]: JsonValue },
  target: CapnpJsonValue,
  budget: DecodeBudget,
  depth: number,
): void {
  const keys = Object.keys(value).sort();
  const entries = target._initObjectValue(keys.length);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const entry = entries.get(index);
    entry.key = validText(key, "JSON object key");
    writeJson(value[key], entry._initValue(), budget, depth + 1);
  }
}

function readFrame(root: WireFrame, budget: DecodeBudget): ControlFrame {
  switch (root.which()) {
    case WireFrame_Which.REQUEST:
      if (!root._hasRequest()) throw invalid("Missing request");
      return readRequest(root.request, budget);
    case WireFrame_Which.RESPONSE:
      if (!root._hasResponse()) throw invalid("Missing response");
      return readResponse(root.response, budget);
    case WireFrame_Which.SIGNAL:
      if (!root._hasSignal()) throw invalid("Missing signal");
      return readSignal(root.signal, budget);
    case WireFrame_Which.FUTURE_FRAME:
      throw invalid("Unsupported frame variant");
    default:
      throw invalid("Unknown frame variant");
  }
}

function readRequest(source: Request, budget: DecodeBudget): ControlFrame {
  if (isNullText(0, source) || isNullText(1, source) || !source._hasArgs()) {
    throw invalid("Incomplete request");
  }
  const frame: Extract<ControlFrame, { type: "req" }> = {
    type: "req",
    id: readText(0, source),
    call: readText(1, source),
    args: readJson(source.args, budget, 0),
  };
  if (!isNullText(3, source)) frame.runId = readText(3, source);
  if (source._hasBody()) frame.body = readBody(source.body);
  return frame;
}

function readResponse(source: Response, budget: DecodeBudget): ControlFrame {
  if (isNullText(0, source)) throw invalid("Missing response id");
  const id = readText(0, source);
  switch (source.which()) {
    case Response_Which.SUCCESS:
      if (!source._hasSuccess()) throw invalid("Missing successful response");
      return readResponseSuccess(id, source.success, budget);
    case Response_Which.FAILURE:
      if (!source._hasFailure()) throw invalid("Missing failed response");
      return readResponseFailure(id, source.failure, budget);
    default:
      throw invalid("Unknown response variant");
  }
}

function readResponseSuccess(
  id: string,
  source: ResponseSuccess,
  budget: DecodeBudget,
): ControlFrame {
  const frame: Extract<ControlFrame, { type: "res"; ok: true }> = {
    type: "res",
    id,
    ok: true,
  };
  if (source._hasData()) frame.data = readJson(source.data, budget, 0);
  if (source._hasBody()) frame.body = readBody(source.body);
  return frame;
}

function readResponseFailure(
  id: string,
  source: ResponseFailure,
  budget: DecodeBudget,
): ControlFrame {
  if (!source._hasError()) throw invalid("Missing response error");
  const error = source.error;
  if (isNullText(0, error)) throw invalid("Missing response error message");
  const code = error.code;
  assertFinite(code, "error code");
  const frame: Extract<ControlFrame, { type: "res"; ok: false }> = {
    type: "res",
    id,
    ok: false,
    error: {
      code,
      message: readText(0, error),
    },
  };
  if (error._hasDetails()) frame.error.details = readJson(error.details, budget, 0);
  switch (error.retryable.which()) {
    case WireError_Retryable_Which.ABSENT:
      break;
    case WireError_Retryable_Which.VALUE:
      frame.error.retryable = error.retryable.value;
      break;
    default:
      throw invalid("Unknown retryable variant");
  }
  return frame;
}

function readSignal(source: Signal, budget: DecodeBudget): ControlFrame {
  if (isNullText(0, source)) throw invalid("Missing signal name");
  const frame: Extract<ControlFrame, { type: "sig" }> = {
    type: "sig",
    signal: readText(0, source),
  };
  if (source._hasPayload()) frame.payload = readJson(source.payload, budget, 0);
  switch (source.seq.which()) {
    case Signal_Seq_Which.ABSENT:
      break;
    case Signal_Seq_Which.VALUE:
      assertFinite(source.seq.value, "signal sequence");
      frame.seq = source.seq.value;
      break;
    default:
      throw invalid("Unknown signal sequence variant");
  }
  return frame;
}

function readBody(source: CapnpBodyDescriptor): BodyDescriptor {
  const streamId = source.streamId;
  if (streamId === 0) throw invalid("Invalid body stream id");
  const body: BodyDescriptor = { streamId };
  switch (source.length.which()) {
    case BodyDescriptor_Length_Which.ABSENT:
      break;
    case BodyDescriptor_Length_Which.VALUE: {
      const value = source.length.value;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("Body length exceeds JSON range");
      body.length = Number(value);
      break;
    }
    default:
      throw invalid("Unknown body length variant");
  }
  return body;
}

function readJson(
  source: CapnpJsonValue,
  budget: DecodeBudget,
  depth: number,
): JsonValue {
  consumeBudget(budget, depth);
  switch (source.which()) {
    case JsonValue_Which.NULL_VALUE:
      return null;
    case JsonValue_Which.BOOL_VALUE:
      return source.boolValue;
    case JsonValue_Which.NUMBER_VALUE:
      assertFinite(source.numberValue, "JSON number");
      return source.numberValue;
    case JsonValue_Which.STRING_VALUE:
      if (isNullText(0, source)) throw invalid("Missing JSON string");
      return readText(0, source);
    case JsonValue_Which.ARRAY_VALUE: {
      if (!source._hasArrayValue()) throw invalid("Missing JSON array");
      const list = source.arrayValue;
      const result: JsonValue[] = [];
      for (let index = 0; index < list.length; index++) {
        result.push(readJson(list.get(index), budget, depth + 1));
      }
      return result;
    }
    case JsonValue_Which.OBJECT_VALUE:
      return readJsonObject(source, budget, depth);
    default:
      throw invalid("Unknown JSON value variant");
  }
}

function readJsonObject(
  source: CapnpJsonValue,
  budget: DecodeBudget,
  depth: number,
): JsonValue {
  if (!source._hasObjectValue()) throw invalid("Missing JSON object");
  const result: { [key: string]: JsonValue } = {};
  const entries = source.objectValue;
  for (let index = 0; index < entries.length; index++) {
    const entry: JsonEntry = entries.get(index);
    if (isNullText(0, entry) || !entry._hasValue()) throw invalid("Incomplete JSON object entry");
    const key = readText(0, entry);
    if (Object.hasOwn(result, key)) throw invalid("Duplicate JSON object key");
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: readJson(entry.value, budget, depth + 1),
      writable: true,
    });
  }
  return result;
}

function readText(index: number, owner: Struct): string {
  const pointer = utils.getPointer(index, owner);
  if (utils.isNull(pointer)) return "";
  const text = Text.fromPointer(pointer);
  const totalLength = text.length + 1;
  if (totalLength < 1) throw invalid("Invalid text length");
  const content = utils.getContent(text);
  const bytes = new Uint8Array(content.segment.buffer, content.byteOffset, totalLength);
  if (bytes[totalLength - 1] !== 0) throw invalid("Text is not NUL terminated");
  try {
    return strictUtf8Decoder.decode(bytes.subarray(0, totalLength - 1));
  } catch {
    throw invalid("Text is not valid UTF-8");
  }
}

function isNullText(index: number, owner: Struct): boolean {
  return utils.isNull(utils.getPointer(index, owner));
}

function validateUnpackedMessage(buffer: ArrayBuffer, limits: ResolvedLimits): void {
  if (buffer.byteLength > limits.maxBytes) throw invalid("Control frame exceeds byte limit");
  if (buffer.byteLength < 8 || buffer.byteLength % 8 !== 0) {
    throw invalid("Invalid Cap'n Proto framing length");
  }
  const view = new DataView(buffer);
  const countMinusOne = view.getUint32(0, true);
  if (countMinusOne === 0xffff_ffff) throw invalid("Invalid segment count");
  const segmentCount = countMinusOne + 1;
  if (segmentCount > limits.maxSegments) throw invalid("Too many Cap'n Proto segments");
  const headerBytes = alignToWord(4 + segmentCount * 4);
  if (headerBytes > buffer.byteLength) throw invalid("Truncated segment table");

  let totalBytes = headerBytes;
  for (let index = 0; index < segmentCount; index++) {
    const words = view.getUint32(4 + index * 4, true);
    if (index === 0 && words === 0) throw invalid("Missing root segment");
    const bytes = words * 8;
    if (bytes > limits.maxBytes - totalBytes) throw invalid("Segment sizes exceed byte limit");
    totalBytes += bytes;
  }
  if (totalBytes !== buffer.byteLength) throw invalid("Segment sizes do not match frame length");
}

function unpackBounded(packed: ArrayBuffer, maxBytes: number): ArrayBuffer {
  if (packed.byteLength > maxBytes) throw invalid("Packed control frame exceeds byte limit");
  const source = new Uint8Array(packed);
  let sourceOffset = 0;
  let outputBytes = 0;

  while (sourceOffset < source.length) {
    const tag = source[sourceOffset++];
    const presentBytes = popcount8(tag);
    if (sourceOffset + presentBytes > source.length) throw invalid("Truncated packed word");
    sourceOffset += presentBytes;
    outputBytes = checkedAdd(outputBytes, 8, maxBytes);

    if (tag === 0) {
      if (sourceOffset >= source.length) throw invalid("Truncated packed zero run");
      outputBytes = checkedAdd(outputBytes, source[sourceOffset++] * 8, maxBytes);
    } else if (tag === 0xff) {
      if (sourceOffset >= source.length) throw invalid("Truncated packed literal run");
      const words = source[sourceOffset++];
      const bytes = words * 8;
      if (sourceOffset + bytes > source.length) throw invalid("Truncated packed literal bytes");
      sourceOffset += bytes;
      outputBytes = checkedAdd(outputBytes, bytes, maxBytes);
    }
  }

  const output = new Uint8Array(outputBytes);
  sourceOffset = 0;
  let outputOffset = 0;
  while (sourceOffset < source.length) {
    const tag = source[sourceOffset++];
    for (let bit = 0; bit < 8; bit++) {
      if ((tag & (1 << bit)) !== 0) output[outputOffset] = source[sourceOffset++];
      outputOffset++;
    }
    if (tag === 0) {
      outputOffset += source[sourceOffset++] * 8;
    } else if (tag === 0xff) {
      const bytes = source[sourceOffset++] * 8;
      output.set(source.subarray(sourceOffset, sourceOffset + bytes), outputOffset);
      sourceOffset += bytes;
      outputOffset += bytes;
    }
  }
  return output.buffer;
}

function consumeBudget(budget: DecodeBudget, depth: number): void {
  if (depth >= budget.maxNesting) throw invalid("JSON nesting limit exceeded");
  budget.remainingNodes--;
  if (budget.remainingNodes < 0) throw invalid("JSON traversal limit exceeded");
}

function resolveLimits(options: DecodeLimits): ResolvedLimits {
  return {
    maxBytes: positiveLimit(options.maxBytes, MAX_CONTROL_FRAME_BYTES),
    maxSegments: positiveLimit(options.maxSegments, MAX_CONTROL_SEGMENTS),
    maxNesting: positiveLimit(options.maxNesting, MAX_CONTROL_NESTING),
    maxPointers: positiveLimit(options.maxPointers, MAX_CONTROL_POINTERS),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid("Invalid decode limit");
  return value;
}

function exactArrayBuffer(source: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (source instanceof ArrayBuffer) return source;
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  return copy.buffer;
}

function exactBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function checkedAdd(current: number, increment: number, limit: number): number {
  if (increment > limit - current) throw invalid("Packed control frame expands past byte limit");
  return current + increment;
}

function popcount8(value: number): number {
  let count = 0;
  for (let bits = value; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
}

function alignToWord(value: number): number {
  return (value + 7) & ~7;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw invalid(`Invalid ${label}`);
}

function validText(value: string, label: string): string {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid(`Invalid Unicode in ${label}`);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalid(`Invalid Unicode in ${label}`);
    }
  }
  return value;
}

function invalid(message: string): InvalidCapnpControlFrameError {
  return new InvalidCapnpControlFrameError(message);
}
