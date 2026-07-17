const INFERENCE_TRANSPORT_VERSION = 1;
const INFERENCE_ENDPOINT = "https://gsv-inference.invalid/v1";
const INFERENCE_REQUEST_MEDIA_TYPE = "application/vnd.gsv.inference-request+json";
const INFERENCE_JSON_MEDIA_TYPE = "application/vnd.gsv.inference-result+json";
const INFERENCE_ERROR_MEDIA_TYPE = "application/vnd.gsv.inference-error+json";
const INFERENCE_VERSION_HEADER = "x-gsv-inference-version";
const INFERENCE_RESULT_HEADER = "x-gsv-inference-result";
const INFERENCE_BINARY_HEADER = "x-gsv-inference-binary";

export const DEFAULT_INFERENCE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const MAX_VALUE_DEPTH = 32;
const MAX_VALUE_NODES = 100_000;
const MAX_OBJECT_FIELDS = 10_000;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_MODEL_BYTES = 512;
const MAX_ERROR_NAME_BYTES = 128;
const MAX_ERROR_MESSAGE_BYTES = 4_096;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type InferenceRunRequest = Readonly<{
  operation: "run";
  model: string;
  input: unknown;
  options?: Readonly<Record<string, unknown>>;
}>;

export type InferenceModelsRequest = Readonly<{
  operation: "models";
  params?: Readonly<Record<string, unknown>>;
}>;

export type InferenceRequest = InferenceRunRequest | InferenceModelsRequest;

export type InferenceTransportLimits = Readonly<{
  maximumBodyBytes?: number;
}>;

type BinaryKind =
  | "array-buffer"
  | "data-view"
  | "int8-array"
  | "uint8-array"
  | "uint8-clamped-array"
  | "int16-array"
  | "uint16-array"
  | "int32-array"
  | "uint32-array"
  | "float32-array"
  | "float64-array"
  | "bigint64-array"
  | "biguint64-array";

type EncodedValue =
  | Readonly<{ t: "null" }>
  | Readonly<{ t: "undefined" }>
  | Readonly<{ t: "boolean"; v: boolean }>
  | Readonly<{ t: "number"; v: number }>
  | Readonly<{ t: "string"; v: string }>
  | Readonly<{ t: "array"; v: readonly EncodedValue[] }>
  | Readonly<{ t: "object"; v: readonly (readonly [string, EncodedValue])[] }>
  | Readonly<{ t: "binary"; k: BinaryKind; v: string }>;

type WireRunRequest = Readonly<{
  version: 1;
  operation: "run";
  model: string;
  input: EncodedValue;
  options?: EncodedValue;
}>;

type WireModelsRequest = Readonly<{
  version: 1;
  operation: "models";
  params?: EncodedValue;
}>;

type WireRequest = WireRunRequest | WireModelsRequest;

type WireError = Readonly<{
  version: 1;
  name: string;
  message: string;
}>;

type TraversalState = {
  nodes: number;
  seen: Set<object>;
  maximumBodyBytes: number;
};

export class InferenceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceProtocolError";
  }
}

export class InferenceTransportError extends Error {
  readonly status: number;

  constructor(message: string, status: number, name = "InferenceTransportError") {
    super(message);
    this.name = name;
    this.status = status;
  }
}

export function createInferenceRequest(
  input: InferenceRequest,
  init: Readonly<{ signal?: AbortSignal }> & InferenceTransportLimits = {},
): Request {
  const maximumBodyBytes = bodyLimit(init);
  const wire = encodeRequest(input, maximumBodyBytes);
  const body = stringifyBounded(wire, maximumBodyBytes, "Inference request");
  return new Request(INFERENCE_ENDPOINT, {
    method: "POST",
    headers: {
      accept: `${INFERENCE_JSON_MEDIA_TYPE}, application/octet-stream`,
      "content-type": `${INFERENCE_REQUEST_MEDIA_TYPE}; version=${INFERENCE_TRANSPORT_VERSION}`,
    },
    body,
    signal: init.signal,
  });
}

export async function decodeInferenceRequest(
  request: Request,
  limits: InferenceTransportLimits = {},
): Promise<InferenceRequest> {
  if (request.method !== "POST") {
    await cancelBody(request.body, "Inference requests must use POST");
    throw new InferenceProtocolError("Inference requests must use POST");
  }
  if (!isVersionedMediaType(request.headers.get("content-type"), INFERENCE_REQUEST_MEDIA_TYPE)) {
    await cancelBody(request.body, "Unsupported inference request content type");
    throw new InferenceProtocolError("Unsupported inference request content type");
  }
  const maximumBodyBytes = bodyLimit(limits);
  const parsed = await readJsonBody(request.body, request.headers, maximumBodyBytes, request.signal);
  return decodeRequest(parsed, maximumBodyBytes);
}

export function encodeInferenceResult(
  value: unknown,
  limits: InferenceTransportLimits = {},
): Response {
  const maximumBodyBytes = bodyLimit(limits);
  if (value instanceof Response) {
    const headers = resultHeaders("response", value.headers);
    return new Response(value.body, {
      status: value.status,
      statusText: value.statusText,
      headers,
    });
  }
  if (value instanceof ReadableStream) {
    return new Response(value, { headers: resultHeaders("stream") });
  }
  const binary = binaryValue(value);
  if (binary) {
    if (binary.bytes.byteLength > maximumBodyBytes) {
      throw new InferenceProtocolError(
        `Inference binary result exceeds ${maximumBodyBytes} bytes`,
      );
    }
    const headers = resultHeaders("binary", {
      "content-type": "application/octet-stream",
      [INFERENCE_BINARY_HEADER]: binary.kind,
    });
    return new Response(copyArrayBuffer(binary.bytes), { headers });
  }

  const encoded = encodeValue(value, traversalState(maximumBodyBytes), 0);
  const body = stringifyBounded(encoded, maximumBodyBytes, "Inference JSON result");
  return new Response(body, {
    headers: resultHeaders("json", {
      "content-type": `${INFERENCE_JSON_MEDIA_TYPE}; version=${INFERENCE_TRANSPORT_VERSION}`,
    }),
  });
}

export function encodeInferenceError(
  error: unknown,
  status = 502,
  limits: InferenceTransportLimits = {},
): Response {
  if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
    throw new TypeError("Inference error status must be between 400 and 599");
  }
  const maximumBodyBytes = bodyLimit(limits);
  const wire: WireError = {
    version: INFERENCE_TRANSPORT_VERSION,
    name: boundedErrorText(
      error instanceof Error && error.name ? error.name : "Error",
      MAX_ERROR_NAME_BYTES,
      "Error",
    ),
    message: boundedErrorText(
      error instanceof Error ? error.message : String(error),
      MAX_ERROR_MESSAGE_BYTES,
      "Inference request failed",
    ),
  };
  const body = stringifyBounded(wire, maximumBodyBytes, "Inference error");
  return new Response(body, {
    status,
    headers: resultHeaders("error", {
      "content-type": `${INFERENCE_ERROR_MEDIA_TYPE}; version=${INFERENCE_TRANSPORT_VERSION}`,
    }),
  });
}

export async function decodeInferenceResponse(
  response: Response,
  limits: InferenceTransportLimits & Readonly<{ signal?: AbortSignal }> = {},
): Promise<unknown> {
  const version = response.headers.get(INFERENCE_VERSION_HEADER);
  const kind = response.headers.get(INFERENCE_RESULT_HEADER);
  if (version !== String(INFERENCE_TRANSPORT_VERSION) || kind === null) {
    await cancelBody(response.body, "Invalid inference service response");
    throw new InferenceTransportError(
      "Inference service returned an invalid response",
      response.status,
    );
  }

  if (kind === "response") {
    const headers = applicationHeaders(response.headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (kind === "stream") {
    if (!response.ok || response.body === null) {
      await cancelBody(response.body, "Invalid inference stream response");
      throw new InferenceTransportError("Inference service returned an invalid stream", response.status);
    }
    return response.body;
  }

  const maximumBodyBytes = bodyLimit(limits);
  if (kind === "error") {
    if (response.status < 400) {
      await cancelBody(response.body, "Invalid inference error response");
      throw new InferenceTransportError("Inference service returned an invalid error", response.status);
    }
    if (!isVersionedMediaType(response.headers.get("content-type"), INFERENCE_ERROR_MEDIA_TYPE)) {
      await cancelBody(response.body, "Invalid inference error content type");
      throw new InferenceTransportError("Inference service returned invalid error metadata", response.status);
    }
    const parsed = await readJsonBody(
      response.body,
      response.headers,
      maximumBodyBytes,
      limits.signal,
    );
    const error = decodeError(parsed);
    throw new InferenceTransportError(error.message, response.status, error.name);
  }

  if (!response.ok) {
    await cancelBody(response.body, "Invalid inference service response status");
    throw new InferenceTransportError("Inference service request failed", response.status);
  }

  if (kind === "binary") {
    const binaryKind = response.headers.get(INFERENCE_BINARY_HEADER);
    if (!isBinaryKind(binaryKind)) {
      await cancelBody(response.body, "Invalid inference binary result kind");
      throw new InferenceTransportError("Inference service returned invalid binary metadata", response.status);
    }
    const bytes = await readBoundedBody(
      response.body,
      response.headers,
      maximumBodyBytes,
      limits.signal,
    );
    return decodeBinary(binaryKind, bytes);
  }

  if (kind === "json") {
    if (!isVersionedMediaType(response.headers.get("content-type"), INFERENCE_JSON_MEDIA_TYPE)) {
      await cancelBody(response.body, "Invalid inference JSON content type");
      throw new InferenceTransportError("Inference service returned invalid JSON metadata", response.status);
    }
    const parsed = await readJsonBody(
      response.body,
      response.headers,
      maximumBodyBytes,
      limits.signal,
    );
    return decodeValue(parsed, traversalState(maximumBodyBytes), 0);
  }

  await cancelBody(response.body, "Unknown inference result kind");
  throw new InferenceTransportError("Inference service returned an unknown result kind", response.status);
}

function encodeRequest(input: InferenceRequest, maximumBodyBytes: number): WireRequest {
  if (input.operation === "run") {
    if (!isPlainRecord(input)) throw new InferenceProtocolError("Inference run request must be an object");
    assertExactKeys(input, ["operation", "model", "input", "options"], "Inference run request");
    requireBoundedString(input.model, MAX_MODEL_BYTES, "Inference model");
    if (input.options !== undefined && !isPlainRecord(input.options)) {
      throw new InferenceProtocolError("Inference options must be an object");
    }
    const state = traversalState(maximumBodyBytes);
    return {
      version: INFERENCE_TRANSPORT_VERSION,
      operation: "run",
      model: input.model,
      input: encodeValue(input.input, state, 0),
      ...(input.options === undefined
        ? {}
        : { options: encodeValue(input.options, state, 0) }),
    };
  }
  if (input.operation === "models") {
    if (!isPlainRecord(input)) throw new InferenceProtocolError("Inference models request must be an object");
    assertExactKeys(input, ["operation", "params"], "Inference models request");
    if (input.params !== undefined && !isPlainRecord(input.params)) {
      throw new InferenceProtocolError("Inference model parameters must be an object");
    }
    return {
      version: INFERENCE_TRANSPORT_VERSION,
      operation: "models",
      ...(input.params === undefined
        ? {}
        : { params: encodeValue(input.params, traversalState(maximumBodyBytes), 0) }),
    };
  }
  throw new InferenceProtocolError("Unknown inference operation");
}

function decodeRequest(value: unknown, maximumBodyBytes: number): InferenceRequest {
  const record = requireRecord(value, "Inference request");
  if (record.version !== INFERENCE_TRANSPORT_VERSION) {
    throw new InferenceProtocolError("Unsupported inference transport version");
  }
  if (record.operation === "run") {
    assertExactKeys(record, ["version", "operation", "model", "input", "options"], "Inference run request");
    const model = requireBoundedString(record.model, MAX_MODEL_BYTES, "Inference model");
    const state = traversalState(maximumBodyBytes);
    const input = decodeValue(record.input, state, 0);
    const options = record.options === undefined
      ? undefined
      : decodeValue(record.options, state, 0);
    if (options !== undefined && !isPlainRecord(options)) {
      throw new InferenceProtocolError("Inference options must decode to an object");
    }
    return { operation: "run", model, input, ...(options === undefined ? {} : { options }) };
  }
  if (record.operation === "models") {
    assertExactKeys(record, ["version", "operation", "params"], "Inference models request");
    const params = record.params === undefined
      ? undefined
      : decodeValue(record.params, traversalState(maximumBodyBytes), 0);
    if (params !== undefined && !isPlainRecord(params)) {
      throw new InferenceProtocolError("Inference model parameters must decode to an object");
    }
    return { operation: "models", ...(params === undefined ? {} : { params }) };
  }
  throw new InferenceProtocolError("Unknown inference operation");
}

function encodeValue(value: unknown, state: TraversalState, depth: number): EncodedValue {
  visit(state, depth);
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undefined" };
  if (typeof value === "boolean") return { t: "boolean", v: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InferenceProtocolError("Inference values cannot contain non-finite numbers");
    return { t: "number", v: value };
  }
  if (typeof value === "string") {
    requireBoundedString(value, state.maximumBodyBytes, "Inference string value");
    return { t: "string", v: value };
  }
  const binary = binaryValue(value);
  if (binary) {
    if (binary.bytes.byteLength > state.maximumBodyBytes) {
      throw new InferenceProtocolError("Inference binary value is too large");
    }
    return { t: "binary", k: binary.kind, v: encodeBase64(binary.bytes) };
  }
  if (typeof value !== "object") {
    throw new InferenceProtocolError(`Inference values cannot contain ${typeof value}`);
  }
  if (state.seen.has(value)) throw new InferenceProtocolError("Inference values cannot contain cycles");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) throw new InferenceProtocolError("Inference array has too many items");
      return { t: "array", v: value.map((item) => encodeValue(item, state, depth + 1)) };
    }
    if (!isPlainRecord(value)) {
      throw new InferenceProtocolError("Inference values must use plain objects");
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_FIELDS) throw new InferenceProtocolError("Inference object has too many fields");
    return {
      t: "object",
      v: entries.map(([key, item]) => [
        requireBoundedString(key, state.maximumBodyBytes, "Inference object key"),
        encodeValue(item, state, depth + 1),
      ] as const),
    };
  } finally {
    state.seen.delete(value);
  }
}

function decodeValue(value: unknown, state: TraversalState, depth: number): unknown {
  visit(state, depth);
  const record = requireRecord(value, "Encoded inference value");
  if (record.t === "null") {
    assertExactKeys(record, ["t"], "Encoded null");
    return null;
  }
  if (record.t === "undefined") {
    assertExactKeys(record, ["t"], "Encoded undefined");
    return undefined;
  }
  if (record.t === "boolean") {
    assertExactKeys(record, ["t", "v"], "Encoded boolean");
    if (typeof record.v !== "boolean") throw new InferenceProtocolError("Encoded boolean is invalid");
    return record.v;
  }
  if (record.t === "number") {
    assertExactKeys(record, ["t", "v"], "Encoded number");
    if (typeof record.v !== "number" || !Number.isFinite(record.v)) {
      throw new InferenceProtocolError("Encoded number is invalid");
    }
    return record.v;
  }
  if (record.t === "string") {
    assertExactKeys(record, ["t", "v"], "Encoded string");
    return requireBoundedString(record.v, state.maximumBodyBytes, "Encoded string");
  }
  if (record.t === "binary") {
    assertExactKeys(record, ["t", "k", "v"], "Encoded binary");
    if (!isBinaryKind(record.k) || typeof record.v !== "string") {
      throw new InferenceProtocolError("Encoded binary is invalid");
    }
    const bytes = decodeBase64(record.v, state.maximumBodyBytes);
    return decodeBinary(record.k, bytes);
  }
  if (record.t === "array") {
    assertExactKeys(record, ["t", "v"], "Encoded array");
    if (!Array.isArray(record.v) || record.v.length > MAX_ARRAY_ITEMS) {
      throw new InferenceProtocolError("Encoded array is invalid");
    }
    return record.v.map((item) => decodeValue(item, state, depth + 1));
  }
  if (record.t === "object") {
    assertExactKeys(record, ["t", "v"], "Encoded object");
    if (!Array.isArray(record.v) || record.v.length > MAX_OBJECT_FIELDS) {
      throw new InferenceProtocolError("Encoded object is invalid");
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of record.v) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new InferenceProtocolError("Encoded object field is invalid");
      }
      const key = requireBoundedString(pair[0], state.maximumBodyBytes, "Encoded object key");
      if (Object.hasOwn(output, key)) throw new InferenceProtocolError("Encoded object has duplicate fields");
      output[key] = decodeValue(pair[1], state, depth + 1);
    }
    return output;
  }
  throw new InferenceProtocolError("Unknown encoded inference value");
}

function binaryValue(value: unknown): { kind: BinaryKind; bytes: Uint8Array } | null {
  if (value instanceof ArrayBuffer) {
    return { kind: "array-buffer", bytes: new Uint8Array(value) };
  }
  if (!ArrayBuffer.isView(value)) return null;
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof DataView) return { kind: "data-view", bytes };
  if (value instanceof Int8Array) return { kind: "int8-array", bytes };
  if (value instanceof Uint8ClampedArray) return { kind: "uint8-clamped-array", bytes };
  if (value instanceof Uint8Array) return { kind: "uint8-array", bytes };
  if (value instanceof Int16Array) return { kind: "int16-array", bytes };
  if (value instanceof Uint16Array) return { kind: "uint16-array", bytes };
  if (value instanceof Int32Array) return { kind: "int32-array", bytes };
  if (value instanceof Uint32Array) return { kind: "uint32-array", bytes };
  if (value instanceof Float32Array) return { kind: "float32-array", bytes };
  if (value instanceof Float64Array) return { kind: "float64-array", bytes };
  if (typeof BigInt64Array !== "undefined" && value instanceof BigInt64Array) {
    return { kind: "bigint64-array", bytes };
  }
  if (typeof BigUint64Array !== "undefined" && value instanceof BigUint64Array) {
    return { kind: "biguint64-array", bytes };
  }
  throw new InferenceProtocolError("Unsupported inference binary view");
}

function decodeBinary(kind: BinaryKind, bytes: Uint8Array): ArrayBuffer | ArrayBufferView {
  const buffer = copyArrayBuffer(bytes);
  try {
    switch (kind) {
      case "array-buffer": return buffer;
      case "data-view": return new DataView(buffer);
      case "int8-array": return new Int8Array(buffer);
      case "uint8-array": return new Uint8Array(buffer);
      case "uint8-clamped-array": return new Uint8ClampedArray(buffer);
      case "int16-array": return new Int16Array(buffer);
      case "uint16-array": return new Uint16Array(buffer);
      case "int32-array": return new Int32Array(buffer);
      case "uint32-array": return new Uint32Array(buffer);
      case "float32-array": return new Float32Array(buffer);
      case "float64-array": return new Float64Array(buffer);
      case "bigint64-array": return new BigInt64Array(buffer);
      case "biguint64-array": return new BigUint64Array(buffer);
    }
  } catch {
    throw new InferenceProtocolError("Inference binary length does not match its type");
  }
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isBinaryKind(value: unknown): value is BinaryKind {
  return value === "array-buffer"
    || value === "data-view"
    || value === "int8-array"
    || value === "uint8-array"
    || value === "uint8-clamped-array"
    || value === "int16-array"
    || value === "uint16-array"
    || value === "int32-array"
    || value === "uint32-array"
    || value === "float32-array"
    || value === "float64-array"
    || value === "bigint64-array"
    || value === "biguint64-array";
}

async function readJsonBody(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maximumBodyBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const bytes = await readBoundedBody(body, headers, maximumBodyBytes, signal);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InferenceProtocolError("Inference JSON is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InferenceProtocolError("Inference JSON is malformed");
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maximumBodyBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maximumBodyBytes) {
      await cancelBody(body, "Inference body is too large");
      throw new InferenceProtocolError(`Inference body exceeds ${maximumBodyBytes} bytes`);
    }
  }
  if (body === null) throw new InferenceProtocolError("Inference body is missing");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBodyBytes) {
        await reader.cancel("Inference body is too large").catch(() => {});
        throw new InferenceProtocolError(`Inference body exceeds ${maximumBodyBytes} bytes`);
      }
      chunks.push(value);
    }
    if (signal?.aborted) throw abortReason(signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function resultHeaders(kind: string, input?: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.set(INFERENCE_VERSION_HEADER, String(INFERENCE_TRANSPORT_VERSION));
  headers.set(INFERENCE_RESULT_HEADER, kind);
  return headers;
}

function applicationHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  headers.delete(INFERENCE_VERSION_HEADER);
  headers.delete(INFERENCE_RESULT_HEADER);
  headers.delete(INFERENCE_BINARY_HEADER);
  return headers;
}

function decodeError(value: unknown): WireError {
  const record = requireRecord(value, "Inference error");
  assertExactKeys(record, ["version", "name", "message"], "Inference error");
  if (record.version !== INFERENCE_TRANSPORT_VERSION) {
    throw new InferenceProtocolError("Unsupported inference error version");
  }
  return {
    version: INFERENCE_TRANSPORT_VERSION,
    name: requireBoundedString(record.name, MAX_ERROR_NAME_BYTES, "Inference error name"),
    message: requireBoundedString(record.message, MAX_ERROR_MESSAGE_BYTES, "Inference error message"),
  };
}

function bodyLimit(input: InferenceTransportLimits): number {
  const value = input.maximumBodyBytes ?? DEFAULT_INFERENCE_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Inference body limit must be a positive safe integer");
  }
  return value;
}

function traversalState(maximumBodyBytes: number): TraversalState {
  return { nodes: 0, seen: new Set(), maximumBodyBytes };
}

function visit(state: TraversalState, depth: number): void {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES) throw new InferenceProtocolError("Inference value has too many nodes");
  if (depth > MAX_VALUE_DEPTH) throw new InferenceProtocolError("Inference value is too deeply nested");
}

function stringifyBounded(value: unknown, maximumBodyBytes: number, label: string): string {
  const output = JSON.stringify(value);
  if (new TextEncoder().encode(output).byteLength > maximumBodyBytes) {
    throw new InferenceProtocolError(`${label} exceeds ${maximumBodyBytes} bytes`);
  }
  return output;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new InferenceProtocolError(`${label} must be an object`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new InferenceProtocolError(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
  }
}

function requireBoundedString(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InferenceProtocolError(`${label} must be a non-empty string`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new InferenceProtocolError(`${label} is too large`);
  }
  return value;
}

function boundedErrorText(value: string, maximumBytes: number, fallback: string): string {
  const normalized = value.trim() || fallback;
  const encoder = new TextEncoder();
  if (encoder.encode(normalized).byteLength <= maximumBytes) return normalized;
  let output = "";
  for (const character of normalized) {
    if (encoder.encode(`${output}${character}`).byteLength > maximumBytes) break;
    output += character;
  }
  return output || fallback;
}

function isVersionedMediaType(value: string | null, expected: string): boolean {
  if (value === null) return false;
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== expected) return false;
  const parameters = new Map(parts.slice(1).map((part) => {
    const index = part.indexOf("=");
    return index < 1 ? [part, ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  return parameters.get("version") === String(INFERENCE_TRANSPORT_VERSION);
}

async function cancelBody(body: ReadableStream | null, reason: string): Promise<void> {
  if (body !== null && !body.locked) await body.cancel(reason).catch(() => {});
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Inference request was aborted", "AbortError");
}

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(packed >>> 18) & 63];
    output += BASE64_ALPHABET[(packed >>> 12) & 63];
    output += index + 1 < bytes.byteLength ? BASE64_ALPHABET[(packed >>> 6) & 63] : "=";
    output += index + 2 < bytes.byteLength ? BASE64_ALPHABET[packed & 63] : "=";
  }
  return output;
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new InferenceProtocolError("Inference binary value is not canonical base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const length = (value.length / 4) * 3 - padding;
  if (length > maximumBytes) throw new InferenceProtocolError("Inference binary value is too large");
  const output = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const packed = (base64Index(value[index]) << 18)
      | (base64Index(value[index + 1]) << 12)
      | ((value[index + 2] === "=" ? 0 : base64Index(value[index + 2])) << 6)
      | (value[index + 3] === "=" ? 0 : base64Index(value[index + 3]));
    if (offset < length) output[offset++] = (packed >>> 16) & 255;
    if (offset < length) output[offset++] = (packed >>> 8) & 255;
    if (offset < length) output[offset++] = packed & 255;
  }
  if (encodeBase64(output) !== value) {
    throw new InferenceProtocolError("Inference binary value is not canonical base64");
  }
  return output;
}

function base64Index(character: string): number {
  const index = BASE64_ALPHABET.indexOf(character);
  if (index < 0) throw new InferenceProtocolError("Inference binary value is not canonical base64");
  return index;
}
