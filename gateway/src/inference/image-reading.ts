import type {
  AiImageObject,
  AiImagePoint,
  AiImageReadMetrics,
  AiImageReadReasoning,
  AiImageReadResponseFormat,
  AiImageReadResult,
} from "@humansandmachines/gsv/protocol";
import { normalizeBase64Data } from "../shared/base64";
import { TimeoutError, withTimeout } from "./timeout";

export type ImageReadingBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
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
  schema?: Record<string, unknown>;
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
const RESPONSE_FORMATS = new Set<AiImageReadResponseFormat>([
  "text",
  "json",
  "xml",
  "markdown",
  "csv",
]);

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
  request.signal?.throwIfAborted();

  if (request.stream) {
    if (!(response instanceof ReadableStream)) {
      throw new Error("Moondream streaming returned no response stream");
    }
    return {
      result: {
        mode: mode as "caption" | "query" | "ocr",
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
    result: normalizeMoondreamResponse(response, mode, responseFormat, request),
  };
}

async function awaitMoondreamRun(
  operation: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
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

export function normalizeImageReadingText(value: unknown): string | null {
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
  let buffer = "";
  let closed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const cleanup = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    options.signal?.removeEventListener("abort", abort);
  };
  const fail = (reason: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    void reader.cancel(reason).catch(() => {});
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

      void (async () => {
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              emitSseEvents(buffer, controller, encoder, true);
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
              emitSseEvents(event, controller, encoder, true);
            }
          }
        } catch (error) {
          fail(error);
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
): Record<string, unknown> {
  const maxTokens = normalizePositiveNumber(request.maxTokens)
    ?? DEFAULT_IMAGE_READING_MAX_TOKENS;
  const input: Record<string, unknown> = {
    task: mode === "ocr" ? "query" : mode,
    image: `data:${normalizeImageMimeType(request.mimeType)};base64,${base64}`,
    stream: request.stream === true,
    max_tokens: maxTokens,
  };

  const temperature = normalizeBoundedNumber(request.temperature, 0, 2);
  const topP = normalizeBoundedNumber(request.topP, 0, 1);
  if (temperature !== undefined) input.temperature = temperature;
  if (topP !== undefined) input.top_p = topP;

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
}

function normalizeMoondreamResponse(
  value: unknown,
  mode: ImageReadingMode,
  responseFormat: AiImageReadResponseFormat,
  request: ImageReadingRequest,
): AiImageReadResult {
  if (!value || typeof value !== "object") {
    throw new Error("Moondream returned an invalid response");
  }
  const record = value as Record<string, unknown>;
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
    return {
      ...metadata,
      mode,
      text: answer,
      answer,
      responseFormat,
      ...(responseFormat === "json"
        ? { structured: parseAndValidateJson(answer, request.schema) }
        : {}),
    };
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

function appendResponseFormatInstruction(
  prompt: string,
  responseFormat: AiImageReadResponseFormat,
  schema: Record<string, unknown> | undefined,
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
  schema: Record<string, unknown> | undefined,
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Moondream returned invalid JSON");
  }
  if (schema) {
    validateJsonSchemaValue(parsed, schema, "$");
  }
  return parsed;
}

function validateJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    throw new Error(`Moondream JSON does not match schema at ${path}: value is not in enum`);
  }

  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((item): item is string => typeof item === "string")
      : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    throw new Error(`Moondream JSON does not match schema at ${path}: expected ${types.join(" or ")}`);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, index) => {
      validateJsonSchemaValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`);
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const object = value as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in object)) {
      throw new Error(`Moondream JSON does not match schema at ${path}: missing ${key}`);
    }
  }

  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  for (const [key, child] of Object.entries(properties)) {
    if (key in object && child && typeof child === "object") {
      validateJsonSchemaValue(
        object[key],
        child as Record<string, unknown>,
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

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
}

function normalizeFinishReason(record: Record<string, unknown>): { finishReason?: string } {
  return typeof record.finish_reason === "string"
    ? { finishReason: record.finish_reason }
    : {};
}

function normalizeMetrics(value: unknown): { metrics?: AiImageReadMetrics } {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const inputTokens = finiteNumber(record.input_tokens);
  const outputTokens = finiteNumber(record.output_tokens);
  const prefillTimeMs = finiteNumber(record.prefill_time_ms);
  const decodeTimeMs = finiteNumber(record.decode_time_ms);
  const timeToFirstTokenMs = finiteNumber(record.ttft_ms);
  return inputTokens === undefined
      || outputTokens === undefined
      || prefillTimeMs === undefined
      || decodeTimeMs === undefined
      || timeToFirstTokenMs === undefined
    ? {}
    : {
      metrics: {
        inputTokens,
        outputTokens,
        prefillTimeMs,
        decodeTimeMs,
        timeToFirstTokenMs,
      },
    };
}

function normalizeReasoning(value: unknown): { reasoning?: AiImageReadReasoning } {
  if (!value || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const grounding = Array.isArray(record.grounding)
    ? record.grounding.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const entry = item as Record<string, unknown>;
      const startIndex = finiteNumber(entry.start_idx);
      const endIndex = finiteNumber(entry.end_idx);
      if (startIndex === undefined || endIndex === undefined) {
        return [];
      }
      return [{
        startIndex,
        endIndex,
        points: normalizePoints(entry.points),
      }];
    })
    : [];
  return text || grounding.length > 0 ? { reasoning: { text, grounding } } : {};
}

function normalizePoints(value: unknown): AiImagePoint[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      const x = finiteNumber(item[0]);
      const y = finiteNumber(item[1]);
      return x === undefined || y === undefined ? [] : [{ x, y }];
    }
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    return x === undefined || y === undefined ? [] : [{ x, y }];
  });
}

function normalizeObjects(value: unknown): AiImageObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const xMin = finiteNumber(record.x_min);
    const yMin = finiteNumber(record.y_min);
    const xMax = finiteNumber(record.x_max);
    const yMax = finiteNumber(record.y_max);
    return xMin === undefined || yMin === undefined || xMax === undefined || yMax === undefined
      ? []
      : [{ xMin, yMin, xMax, yMax }];
  });
}

function emitSseEvents(
  input: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error("Moondream returned invalid streaming data");
    }
    const text = streamEventText(parsed);
    if (text) {
      controller.enqueue(encoder.encode(text));
    }
  }
}

function streamEventText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const candidate of [
    record.text,
    record.chunk,
    record.answer,
    record.caption,
    record.response,
  ]) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  if (record.error) {
    throw new Error(typeof record.error === "string"
      ? record.error
      : "Moondream streaming failed");
  }
  return "";
}

function firstText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const candidate of [
    record.answer,
    record.caption,
    record.text,
    record.response,
    record.content,
  ]) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function normalizeMode(value: unknown): ImageReadingMode {
  if (
    value === "caption"
    || value === "query"
    || value === "ocr"
    || value === "point"
    || value === "detect"
  ) {
    return value;
  }
  if (value === undefined) {
    return "caption";
  }
  throw new Error("mode must be caption, query, ocr, point, or detect");
}

function normalizeResponseFormat(value: unknown): AiImageReadResponseFormat {
  if (value === undefined) {
    return "text";
  }
  if (typeof value === "string" && RESPONSE_FORMATS.has(value as AiImageReadResponseFormat)) {
    return value as AiImageReadResponseFormat;
  }
  throw new Error("responseFormat must be text, json, xml, markdown, or csv");
}

function normalizeImageMimeType(value: unknown): string {
  const normalized = normalizeOptionalText(value);
  return normalized && normalized.startsWith("image/") ? normalized : "image/png";
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number"
      && Number.isFinite(value)
      && value >= minimum
      && value <= maximum
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
