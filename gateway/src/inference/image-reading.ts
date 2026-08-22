import type {
  AiImageObject,
  AiImagePoint,
  AiImageReadMetrics,
  AiImageReadReasoning,
  AiImageReadResponseFormat,
  AiImageReadResult,
  JsonObject,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { normalizeBase64Data } from "../shared/base64";
import { TimeoutError, withTimeout } from "./timeout";

type MoondreamInput = {
  task: "caption" | "query" | "point" | "detect";
  image: string;
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  caption_length?: "short" | "normal" | "long";
  question?: string;
  reasoning?: boolean;
  target?: string;
  max_objects?: number;
};

type MoondreamProviderResponse = JsonValue | ReadableStream<Uint8Array>;

export type ImageReadingBinding = {
  run(model: string, input: MoondreamInput): Promise<MoondreamProviderResponse>;
};

export type ImageReadingMode = "caption" | "query" | "ocr" | "point" | "detect";

export type ImageReadingRequest = {
  data: string;
  mimeType?: string;
  mode?: ImageReadingMode;
  prompt?: string;
  target?: string;
  captionLength?: "short" | "normal" | "long";
  reasoning?: boolean;
  responseFormat?: AiImageReadResponseFormat;
  schema?: JsonObject;
  stream?: boolean;
  maxTokens?: number;
  maxObjects?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ImageReadingResponse = {
  result: AiImageReadResult;
  stream?: ReadableStream<Uint8Array>;
};

export const MOONDREAM_IMAGE_READING_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
export const DEFAULT_IMAGE_READING_MODEL = MOONDREAM_IMAGE_READING_MODEL;
export const DEFAULT_MAX_IMAGE_READING_BYTES = 10 * 1024 * 1024;
export const DEFAULT_IMAGE_READING_MAX_TOKENS = 8192;
export const DEFAULT_IMAGE_READING_MAX_OBJECTS = 150;
export const DEFAULT_IMAGE_READING_TIMEOUT_MS = 30_000;

const OCR_PROMPT =
  "Transcribe all visible text exactly. Preserve reading order, line breaks, and layout.";
const streamingModeSchema = z.enum(["caption", "query", "ocr"]);
const finiteNumberSchema = z.number().finite();
const nonEmptyTextSchema = z.string().trim().min(1);
const providerMetricsSchema = z.object({
  input_tokens: finiteNumberSchema,
  output_tokens: finiteNumberSchema,
  prefill_time_ms: finiteNumberSchema,
  decode_time_ms: finiteNumberSchema,
  ttft_ms: finiteNumberSchema,
});
const providerPointTupleSchema = z.tuple([
  finiteNumberSchema,
  finiteNumberSchema,
]).rest(jsonValueSchema);
const providerPointObjectSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
});
const providerObjectSchema = z.object({
  x_min: finiteNumberSchema,
  y_min: finiteNumberSchema,
  x_max: finiteNumberSchema,
  y_max: finiteNumberSchema,
});
const providerGroundingSchema = z.object({
  start_idx: finiteNumberSchema,
  end_idx: finiteNumberSchema,
  points: z.array(jsonValueSchema).optional(),
});
const providerReasoningSchema = z.object({
  text: z.string().optional(),
  grounding: z.array(jsonValueSchema).optional(),
});
const jsonSchemaTypesSchema = z.union([
  z.string().transform((value) => [value]),
  z.array(z.string()),
]);
const stringArraySchema = z.array(z.string());
const jsonValueArraySchema = z.array(jsonValueSchema);
const streamFailureSchema = z.instanceof(Error).catch(
  new Error("Image reading stream failed"),
);

type ImageReadMetricsProjection = { metrics?: AiImageReadMetrics };
type ImageReadReasoningProjection = { reasoning?: AiImageReadReasoning };
type ImageReadFinishProjection = { finishReason?: string };

export async function readImage(
  ai: ImageReadingBinding | undefined,
  request: ImageReadingRequest,
): Promise<ImageReadingResponse | null> {
  if (!ai) {
    return null;
  }

  const mode = normalizeMode(request.mode);
  const base64 = normalizeBase64Data(request.data);
  if (!base64) {
    return null;
  }

  const responseFormat = normalizeResponseFormat(request.responseFormat);
  validateRequest(request, mode, responseFormat);
  const timeoutMs = normalizePositiveNumber(request.timeoutMs)
    ?? DEFAULT_IMAGE_READING_TIMEOUT_MS;
  const input = buildMoondreamInput(request, mode, base64, responseFormat);
  request.signal?.throwIfAborted();
  const startedAt = Date.now();
  const response = await awaitMoondreamRun(
    ai.run(MOONDREAM_IMAGE_READING_MODEL, input),
    timeoutMs,
    request.signal,
  );
  if (request.signal?.aborted) {
    if (response instanceof ReadableStream) {
      await response.cancel(request.signal.reason).catch(() => {});
    }
    request.signal.throwIfAborted();
  }

  if (request.stream) {
    if (!(response instanceof ReadableStream)) {
      throw new Error("Moondream streaming returned no response stream");
    }
    return {
      result: {
        mode: streamingModeSchema.parse(mode),
        streamed: true,
        contentType: "text/plain; charset=utf-8",
        provider: "workers-ai",
        model: MOONDREAM_IMAGE_READING_MODEL,
      },
      stream: decodeMoondreamStream(response, {
        signal: request.signal,
        timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
      }),
    };
  }
  if (response instanceof ReadableStream) {
    await response.cancel().catch(() => {});
    throw new Error("Moondream returned an unexpected response stream");
  }

  return {
    result: normalizeMoondreamResponse(
      jsonValueSchema.parse(response),
      mode,
      responseFormat,
      request,
    ),
  };
}

async function awaitMoondreamRun(
  operation: Promise<MoondreamProviderResponse>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<MoondreamProviderResponse> {
  let accepted = false;
  const timed = withTimeout(
    operation,
    timeoutMs,
    `Image reading timed out after ${timeoutMs}ms`,
  );
  try {
    const response = await raceWithAbort(timed, signal);
    accepted = true;
    return response;
  } finally {
    if (!accepted) {
      void operation.then((lateResponse) => {
        if (lateResponse instanceof ReadableStream) {
          return lateResponse.cancel().catch(() => {});
        }
      }, () => {});
    }
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Image reading cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Image reading cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export function normalizeImageReadingText(value: JsonValue | undefined): string | null {
  const text = firstText(value);
  return text === null ? null : text.trim() || null;
}

export function decodeMoondreamStream(
  source: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streamState = { cumulativeText: "" };
  let buffer = "";
  let closed = false;
  let pumpStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    options.signal?.removeEventListener("abort", abort);
  };
  const fail = (reason: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    const cancellation = reader.cancel(reason).catch(() => {});
    if (!pumpStarted) {
      void cancellation.finally(() => reader.releaseLock());
    }
    controller.error(reason);
  };
  const abort = () => fail(
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error("Image reading cancelled"),
  );

  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          fail(new TimeoutError(`Image reading timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      pumpStarted = true;
      void (async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              emitSseEvents(buffer, controller, encoder, streamState, true);
              closed = true;
              cleanup();
              controller.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            for (;;) {
              const normalized = buffer.replace(/\r\n/g, "\n");
              const boundary = normalized.indexOf("\n\n");
              if (boundary < 0) {
                break;
              }
              const event = normalized.slice(0, boundary);
              buffer = normalized.slice(boundary + 2);
              emitSseEvents(event, controller, encoder, streamState, true);
            }
          }
        } catch (error) {
          fail(streamFailureSchema.parse(error));
        } finally {
          reader.releaseLock();
        }
      })();
    },
    async cancel(reason) {
      if (!closed) {
        closed = true;
        cleanup();
        await reader.cancel(reason).catch(() => {});
      }
    },
  });
}

function buildMoondreamInput(
  request: ImageReadingRequest,
  mode: ImageReadingMode,
  base64: string,
  responseFormat: AiImageReadResponseFormat,
): MoondreamInput {
  const input: MoondreamInput = {
    task: mode === "ocr" ? "query" : mode,
    image: `data:${normalizeImageMimeType(request.mimeType)};base64,${base64}`,
    stream: request.stream === true,
  };

  if (mode === "caption" || mode === "query" || mode === "ocr") {
    input.max_tokens = request.maxTokens ?? DEFAULT_IMAGE_READING_MAX_TOKENS;
    if (request.temperature !== undefined) input.temperature = request.temperature;
    if (request.topP !== undefined) input.top_p = request.topP;
  }
  if (mode === "caption") {
    input.caption_length = request.captionLength ?? "normal";
  } else if (mode === "query" || mode === "ocr") {
    const prompt = mode === "ocr"
      ? normalizeOptionalText(request.prompt) ?? OCR_PROMPT
      : normalizeOptionalText(request.prompt)!;
    input.question = appendResponseFormatInstruction(
      prompt,
      responseFormat,
      request.schema,
    );
    input.reasoning = request.stream ? false : request.reasoning === true;
  } else {
    input.target = normalizeOptionalText(request.target)!;
    input.max_objects = normalizePositiveNumber(request.maxObjects)
      ?? DEFAULT_IMAGE_READING_MAX_OBJECTS;
  }

  return input;
}

function validateRequest(
  request: ImageReadingRequest,
  mode: ImageReadingMode,
  responseFormat: AiImageReadResponseFormat,
): void {
  if (mode === "query" && !normalizeOptionalText(request.prompt)) {
    throw new Error("prompt is required for query mode");
  }
  if ((mode === "point" || mode === "detect") && !normalizeOptionalText(request.target)) {
    throw new Error(`target is required for ${mode} mode`);
  }
  if (request.stream && mode !== "caption" && mode !== "query" && mode !== "ocr") {
    throw new Error("streaming is supported only for caption, query, and ocr modes");
  }
  if (request.stream && request.reasoning) {
    throw new Error("streaming cannot be combined with reasoning");
  }
  if (request.stream && (responseFormat !== "text" || request.schema !== undefined)) {
    throw new Error("streaming cannot be combined with structured output");
  }
  if (request.schema !== undefined && responseFormat !== "json") {
    throw new Error("schema requires responseFormat=json");
  }
  if (
    request.responseFormat !== undefined
    && mode !== "query"
    && mode !== "ocr"
  ) {
    throw new Error("responseFormat is supported only for query and ocr modes");
  }
  if (request.captionLength !== undefined && (
    mode !== "caption"
    || !["short", "normal", "long"].includes(request.captionLength)
  )) {
    throw new Error("captionLength must be short, normal, or long and requires caption mode");
  }
  if (
    request.maxTokens !== undefined
    && (
      mode === "point"
      || mode === "detect"
      || !Number.isSafeInteger(request.maxTokens)
      || request.maxTokens < 1
      || request.maxTokens > 28_672
    )
  ) {
    throw new Error("maxTokens must be an integer from 1 to 28672 for caption, query, or ocr");
  }
  if (
    request.maxObjects !== undefined
    && (
      (mode !== "point" && mode !== "detect")
      || !Number.isSafeInteger(request.maxObjects)
      || request.maxObjects < 1
      || request.maxObjects > 500
    )
  ) {
    throw new Error("maxObjects must be an integer from 1 to 500 for point or detect");
  }
  if (
    request.temperature !== undefined
    && (
      mode === "point"
      || mode === "detect"
      || !Number.isFinite(request.temperature)
      || request.temperature < 0
      || request.temperature > 2
    )
  ) {
    throw new Error("temperature must be from 0 to 2 for caption, query, or ocr");
  }
  if (
    request.topP !== undefined
    && (
      mode === "point"
      || mode === "detect"
      || !Number.isFinite(request.topP)
      || request.topP < 0
      || request.topP > 1
    )
  ) {
    throw new Error("topP must be from 0 to 1 for caption, query, or ocr");
  }
}

function normalizeMoondreamResponse(
  value: JsonValue,
  mode: ImageReadingMode,
  responseFormat: AiImageReadResponseFormat,
  request: ImageReadingRequest,
): AiImageReadResult {
  const record = moondreamResultRecord(value);
  const metadata = {
    provider: "workers-ai",
    model: MOONDREAM_IMAGE_READING_MODEL,
    ...normalizeFinishReason(record),
    ...normalizeMetrics(record.metrics),
    ...normalizeReasoning(record.reasoning),
  };

  if (mode === "caption") {
    const caption = normalizeImageReadingText(record.caption);
    if (!caption) {
      throw new Error("Moondream returned no caption");
    }
    return {
      ...metadata,
      mode,
      text: caption,
      caption,
      captionLength: request.captionLength ?? "normal",
    };
  }
  if (mode === "query" || mode === "ocr") {
    const answer = normalizeImageReadingText(record.answer);
    if (!answer) {
      throw new Error("Moondream returned no answer");
    }
    const result: AiImageReadResult = {
      ...metadata,
      mode,
      text: answer,
      answer,
      responseFormat,
    };
    if (responseFormat === "json") {
      result.structured = parseAndValidateJson(answer, request.schema);
    }
    return result;
  }
  if (mode === "point") {
    return {
      ...metadata,
      mode,
      points: normalizePoints(record.points),
    };
  }
  return {
    ...metadata,
    mode,
    objects: normalizeObjects(record.objects),
  };
}

function moondreamResultRecord(value: JsonValue): JsonObject {
  const envelopeResult = jsonObjectSchema.safeParse(value);
  if (!envelopeResult.success) {
    throw new Error("Moondream returned an invalid response");
  }
  const envelope = envelopeResult.data;
  if (envelope.result === undefined) {
    return envelope;
  }
  const result = jsonObjectSchema.safeParse(envelope.result);
  if (!result.success) {
    throw new Error("Moondream returned an invalid response");
  }
  return result.data;
}

function appendResponseFormatInstruction(
  prompt: string,
  responseFormat: AiImageReadResponseFormat,
  schema: JsonObject | undefined,
): string {
  if (responseFormat === "text") {
    return prompt;
  }
  if (responseFormat === "json") {
    return schema
      ? `${prompt}\n\nReturn only JSON matching this JSON Schema:\n${JSON.stringify(schema)}`
      : `${prompt}\n\nReturn only valid JSON.`;
  }
  return `${prompt}\n\nReturn only ${responseFormat.toUpperCase()}.`;
}

function parseAndValidateJson(
  text: string,
  schema: JsonObject | undefined,
): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = jsonValueSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("Moondream returned invalid JSON");
  }
  if (schema) {
    validateJsonSchemaValue(parsed, schema, "$");
  }
  return parsed;
}

function validateJsonSchemaValue(
  value: JsonValue,
  schema: JsonObject,
  path: string,
): void {
  const enumResult = jsonValueArraySchema.safeParse(schema.enum);
  if (enumResult.success && !enumResult.data.some((item) => Object.is(item, value))) {
    throw new Error(`Moondream JSON does not match schema at ${path}: value is not in enum`);
  }

  const typesResult = jsonSchemaTypesSchema.safeParse(schema.type);
  const types = typesResult.success ? typesResult.data : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    throw new Error(`Moondream JSON does not match schema at ${path}: expected ${types.join(" or ")}`);
  }

  const valuesResult = jsonValueArraySchema.safeParse(value);
  const itemsResult = jsonObjectSchema.safeParse(schema.items);
  if (valuesResult.success && itemsResult.success) {
    valuesResult.data.forEach((item, index) => {
      validateJsonSchemaValue(item, itemsResult.data, `${path}[${index}]`);
    });
  }
  const objectResult = jsonObjectSchema.safeParse(value);
  if (!objectResult.success) {
    return;
  }

  const object = objectResult.data;
  const requiredResult = stringArraySchema.safeParse(schema.required);
  const required = requiredResult.success ? requiredResult.data : [];
  for (const key of required) {
    if (!(key in object)) {
      throw new Error(`Moondream JSON does not match schema at ${path}: missing ${key}`);
    }
  }

  const propertiesResult = jsonObjectSchema.safeParse(schema.properties);
  const properties = propertiesResult.success ? propertiesResult.data : {};
  for (const [key, child] of Object.entries(properties)) {
    const childResult = jsonObjectSchema.safeParse(child);
    if (key in object && childResult.success) {
      validateJsonSchemaValue(
        object[key],
        childResult.data,
        `${path}.${key}`,
      );
    }
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(object).find((key) => !(key in properties));
    if (extra) {
      throw new Error(`Moondream JSON does not match schema at ${path}: unexpected ${extra}`);
    }
  }
}

function matchesJsonType(value: JsonValue, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return jsonValueArraySchema.safeParse(value).success;
    case "object":
      return jsonObjectSchema.safeParse(value).success;
    case "integer":
      return z.number().int().safeParse(value).success;
    case "number":
      return finiteNumberSchema.safeParse(value).success;
    case "string":
      return z.string().safeParse(value).success;
    case "boolean":
      return z.boolean().safeParse(value).success;
    default:
      return true;
  }
}

function normalizeFinishReason(record: JsonObject): ImageReadFinishProjection {
  const result = z.string().safeParse(record.finish_reason);
  return result.success ? { finishReason: result.data } : {};
}

function normalizeMetrics(value: JsonValue | undefined): ImageReadMetricsProjection {
  const result = providerMetricsSchema.safeParse(value);
  if (!result.success) {
    return {};
  }
  return {
    metrics: {
      inputTokens: result.data.input_tokens,
      outputTokens: result.data.output_tokens,
      prefillTimeMs: result.data.prefill_time_ms,
      decodeTimeMs: result.data.decode_time_ms,
      timeToFirstTokenMs: result.data.ttft_ms,
    },
  };
}

function normalizeReasoning(value: JsonValue | undefined): ImageReadReasoningProjection {
  const result = providerReasoningSchema.safeParse(value);
  if (!result.success) {
    return {};
  }
  const text = result.data.text?.trim() ?? "";
  const grounding = result.data.grounding?.flatMap((item) => {
      const entry = providerGroundingSchema.safeParse(item);
      if (!entry.success) {
        return [];
      }
      return [{
        startIndex: entry.data.start_idx,
        endIndex: entry.data.end_idx,
        points: normalizePoints(entry.data.points),
      }];
    }) ?? [];
  return text || grounding.length > 0 ? { reasoning: { text, grounding } } : {};
}

function normalizePoints(value: JsonValue | undefined): AiImagePoint[] {
  const values = jsonValueArraySchema.safeParse(value);
  if (!values.success) {
    return [];
  }
  return values.data.flatMap((item) => {
    const tuple = providerPointTupleSchema.safeParse(item);
    if (tuple.success) {
      return [{ x: tuple.data[0], y: tuple.data[1] }];
    }
    const point = providerPointObjectSchema.safeParse(item);
    return point.success ? [{ x: point.data.x, y: point.data.y }] : [];
  });
}

function normalizeObjects(value: JsonValue | undefined): AiImageObject[] {
  const values = jsonValueArraySchema.safeParse(value);
  if (!values.success) {
    return [];
  }
  return values.data.flatMap((item) => {
    const object = providerObjectSchema.safeParse(item);
    if (!object.success) {
      return [];
    }
    return [{
      xMin: object.data.x_min,
      yMin: object.data.y_min,
      xMax: object.data.x_max,
      yMax: object.data.y_max,
    }];
  });
}

function emitSseEvents(
  input: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: { cumulativeText: string },
  flush: boolean,
): void {
  const events = input.replace(/\r\n/g, "\n").split("\n\n");
  const complete = flush ? events : events.slice(0, -1);
  for (const event of complete) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let parsed: JsonValue;
    try {
      parsed = jsonValueSchema.parse(JSON.parse(data));
    } catch {
      throw new Error("Moondream returned invalid streaming data");
    }
    const text = streamEventText(parsed, state);
    if (text) {
      controller.enqueue(encoder.encode(text));
    }
  }
}

function streamEventText(
  value: JsonValue,
  state: { cumulativeText: string },
): string {
  const textValue = z.string().safeParse(value);
  if (textValue.success) {
    return textValue.data;
  }
  const recordResult = jsonObjectSchema.safeParse(value);
  if (!recordResult.success) {
    return "";
  }
  const record = recordResult.data;
  const chunkResult = jsonObjectSchema.safeParse(record.chunk);
  if (chunkResult.success) {
    const replacement = firstText(chunkResult.data);
    if (replacement !== null) {
      if (replacement.startsWith(state.cumulativeText)) {
        const delta = replacement.slice(state.cumulativeText.length);
        state.cumulativeText = replacement;
        return delta;
      }
      if (state.cumulativeText.startsWith(replacement)) {
        return "";
      }
      state.cumulativeText = replacement;
      return replacement;
    }
  }
  for (const candidate of [
    record.text,
    record.chunk,
    record.answer,
    record.caption,
    record.response,
  ]) {
    const candidateText = z.string().safeParse(candidate);
    if (candidateText.success) {
      return candidateText.data;
    }
  }
  if (record.error) {
    const errorText = z.string().safeParse(record.error);
    throw new Error(errorText.success ? errorText.data : "Moondream streaming failed");
  }
  return "";
}

function firstText(value: JsonValue | undefined): string | null {
  const textValue = z.string().safeParse(value);
  if (textValue.success) {
    return textValue.data;
  }
  const recordResult = jsonObjectSchema.safeParse(value);
  if (!recordResult.success) {
    return null;
  }
  const record = recordResult.data;
  for (const candidate of [
    record.answer,
    record.caption,
    record.text,
    record.response,
    record.content,
  ]) {
    const candidateText = z.string().safeParse(candidate);
    if (candidateText.success) {
      return candidateText.data;
    }
  }
  return null;
}

function normalizeMode(value: ImageReadingMode | undefined): ImageReadingMode {
  return value ?? "caption";
}

function normalizeResponseFormat(
  value: AiImageReadResponseFormat | undefined,
): AiImageReadResponseFormat {
  return value ?? "text";
}

function normalizeImageMimeType(value: string | undefined): string {
  const normalized = normalizeOptionalText(value);
  return normalized && normalized.startsWith("image/") ? normalized : "image/png";
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const result = nonEmptyTextSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function normalizePositiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
