import { withTimeout } from "./timeout";
import { binaryDataFromBase64, binaryDataFromBytes } from "../shared/base64";

export type AudioSpeechBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export type AudioSpeechRequest = {
  text: string;
  model?: string;
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

export const DEFAULT_AUDIO_SPEECH_MODEL = "@cf/deepgram/aura-2-en";
export const DEFAULT_AUDIO_SPEECH_SPEAKER = "luna";
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

  const model = request.model || DEFAULT_AUDIO_SPEECH_MODEL;
  const encoding = normalizeEncoding(request.encoding) || DEFAULT_AUDIO_SPEECH_ENCODING;
  const container = normalizeOptionalText(request.container);
  const voice = model.includes("/melotts")
    ? undefined
    : normalizeOptionalText(request.voice) || defaultVoiceForModel(model);
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
  return audio
    ? {
      ...audio,
      provider: "workers-ai",
      model,
      ...(voice ? { voice } : {}),
      encoding,
      ...(container ? { container } : {}),
    }
    : null;
}

function buildWorkersAiSpeechInput(
  request: Required<Pick<AudioSpeechRequest, "text" | "model" | "encoding">> & AudioSpeechRequest,
): Record<string, unknown> {
  if (request.model.includes("/melotts")) {
    return {
      prompt: request.text,
      lang: normalizeOptionalText(request.language) || "en",
    };
  }

  const input: Record<string, unknown> = {
    text: request.text,
    encoding: request.encoding,
  };
  if (request.voice) {
    input.speaker = request.voice;
  }
  if (request.container) {
    input.container = request.container;
  }
  if (typeof request.sampleRate === "number" && Number.isFinite(request.sampleRate) && request.sampleRate > 0) {
    input.sample_rate = request.sampleRate;
  }
  if (typeof request.bitRate === "number" && Number.isFinite(request.bitRate) && request.bitRate > 0) {
    input.bit_rate = request.bitRate;
  }
  return input;
}

async function normalizeSpeechResponse(
  response: unknown,
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
  if (typeof response === "string" && response.trim().length > 0) {
    return binaryDataFromBase64(response.trim(), fallbackMimeType);
  }
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  const base64 = firstString(record.audio, record.data, record.output, record.result);
  if (base64) {
    const mimeType = firstString(record.mimeType, record.mime_type, record.contentType, record.content_type) || fallbackMimeType;
    return binaryDataFromBase64(base64, mimeType);
  }

  return null;
}


function defaultVoiceForModel(model: string): string | undefined {
  return model.includes("/aura-") ? DEFAULT_AUDIO_SPEECH_SPEAKER : undefined;
}

function normalizeEncoding(value: unknown): string | undefined {
  return normalizeOptionalText(value)?.toLowerCase();
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
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
