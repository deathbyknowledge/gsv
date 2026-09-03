import { withTimeout } from "./timeout";
import { binaryDataFromBase64, binaryDataFromBytes } from "../shared/base64";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

export type AudioSpeechBinding = {
  run(model: string, input: JsonObject): Promise<AudioSpeechResponse>;
};

type AudioSpeechResponse =
  | ReadableStream<Uint8Array>
  | Response
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | JsonValue;

export type AudioSpeechRequest = {
  text: string;
  model: string;
  voice?: string;
  language?: string;
  encoding?: string;
  container?: string;
  sampleRate?: number;
  bitRate?: number;
  timeoutMs?: number;
};

export type AudioSpeechResult = {
  bytes: Uint8Array;
  mimeType: string;
  provider: string;
  model: string;
  voice?: string;
  encoding?: string;
  container?: string;
};

export const DEFAULT_AUDIO_SPEECH_ENCODING = "mp3";
export const DEFAULT_MAX_AUDIO_SPEECH_CHARS = 4000;
export const DEFAULT_AUDIO_SPEECH_TIMEOUT_MS = 30_000;

export async function synthesizeSpeechWithWorkersAi(
  ai: AudioSpeechBinding | undefined,
  request: AudioSpeechRequest,
): Promise<AudioSpeechResult | null> {
  if (!ai) {
    return null;
  }

  const model = request.model.trim();
  if (!model) {
    throw new Error("Speech model is required");
  }
  const encoding = normalizeEncoding(request.encoding) || DEFAULT_AUDIO_SPEECH_ENCODING;
  const container = normalizeOptionalText(request.container);
  const voice = model.includes("/melotts")
    ? undefined
    : normalizeOptionalText(request.voice);
  const input = buildWorkersAiSpeechInput({
    ...request,
    model,
    encoding,
    container,
    voice,
  });

  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;
  const response = await withTimeout(
    ai.run(model, input),
    timeoutMs,
    `Speech synthesis timed out after ${timeoutMs}ms`,
  );
  const audio = await normalizeSpeechResponse(response, mimeTypeForSpeech({ model, encoding, container }));
  if (!audio) return null;
  const result: AudioSpeechResult = { ...audio, provider: "workers-ai", model, encoding };
  if (voice) result.voice = voice;
  if (container) result.container = container;
  return result;
}

function buildWorkersAiSpeechInput(
  request: Required<Pick<AudioSpeechRequest, "text" | "model" | "encoding">> & AudioSpeechRequest,
): JsonObject {
  if (request.model.includes("/melotts")) {
    return {
      prompt: request.text,
      lang: normalizeOptionalText(request.language) || "en",
    };
  }

  const input: JsonObject = {
    text: request.text,
    encoding: request.encoding,
  };
  if (request.voice) {
    input.speaker = request.voice;
  }
  if (request.container) {
    input.container = request.container;
  }
  const sampleRate = normalizePositiveNumber(request.sampleRate);
  if (sampleRate !== undefined) input.sample_rate = sampleRate;
  const bitRate = normalizePositiveNumber(request.bitRate);
  if (bitRate !== undefined) input.bit_rate = bitRate;
  return input;
}

async function normalizeSpeechResponse(
  response: AudioSpeechResponse,
  fallbackMimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  if (response instanceof ReadableStream) {
    return binaryDataFromBytes(await new Response(response).arrayBuffer(), fallbackMimeType);
  }
  if (response instanceof Response) {
    return binaryDataFromBytes(
      await response.arrayBuffer(),
      response.headers.get("content-type") || fallbackMimeType,
    );
  }
  if (response instanceof ArrayBuffer) {
    return binaryDataFromBytes(response, fallbackMimeType);
  }
  if (ArrayBuffer.isView(response)) {
    return binaryDataFromBytes(response, fallbackMimeType);
  }
  if (response instanceof Blob) {
    return binaryDataFromBytes(await response.arrayBuffer(), response.type || fallbackMimeType);
  }
  const parsed = jsonObjectSchema.safeParse(response);
  if (!parsed.success) {
    const text = z.string().safeParse(response);
    return text.success && text.data.trim().length > 0
      ? binaryDataFromBase64(text.data.trim(), fallbackMimeType)
      : null;
  }
  const record = parsed.data;
  const base64 = firstString(record.audio, record.data, record.output, record.result);
  if (base64) {
    const mimeType = firstString(record.mimeType, record.mime_type, record.contentType, record.content_type) || fallbackMimeType;
    return binaryDataFromBase64(base64, mimeType);
  }

  return null;
}


function normalizeEncoding(value: JsonValue | undefined): string | undefined {
  return normalizeOptionalText(value)?.toLowerCase();
}

function normalizePositiveNumber(value: JsonValue | undefined): number | undefined {
  const parsed = z.number().safeParse(value);
  return parsed.success && Number.isFinite(parsed.data) && parsed.data > 0 ? parsed.data : undefined;
}

function normalizeOptionalText(value: JsonValue | undefined): string | undefined {
  const parsed = z.string().safeParse(value);
  return parsed.success && parsed.data.trim().length > 0 ? parsed.data.trim() : undefined;
}

function firstString(...values: JsonValue[]): string | undefined {
  for (const value of values) {
    const text = normalizeOptionalText(value);
    if (text) return text;
  }
  return undefined;
}

function mimeTypeForSpeech(options: { model: string; encoding: string; container?: string }): string {
  if (options.model.includes("/melotts")) {
    return "audio/mpeg";
  }
  const encoding = options.encoding.toLowerCase();
  const container = options.container?.toLowerCase();
  if (encoding === "mp3") return "audio/mpeg";
  if (encoding === "aac") return "audio/aac";
  if (encoding === "flac") return "audio/flac";
  if (encoding === "opus") return container === "ogg" ? "audio/ogg" : "audio/opus";
  if (encoding === "linear16") return container === "wav" ? "audio/wav" : "audio/L16";
  if (encoding === "mulaw") return "audio/basic";
  if (encoding === "alaw") return "audio/G711-0";
  return "audio/mpeg";
}
