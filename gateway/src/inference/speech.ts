import { withTimeout } from "./timeout";
import { encodeBase64Bytes } from "../shared/base64";

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
  data: string;
  mimeType: string;
  size: number;
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
): Promise<{ data: string; mimeType: string; size: number } | null> {
  if (response instanceof ReadableStream) {
    return audioFromArrayBuffer(await new Response(response).arrayBuffer(), fallbackMimeType);
  }
  if (response instanceof Response) {
    return audioFromArrayBuffer(
      await response.arrayBuffer(),
      response.headers.get("content-type") || fallbackMimeType,
    );
  }
  if (response instanceof ArrayBuffer) {
    return audioFromArrayBuffer(response, fallbackMimeType);
  }
  if (ArrayBuffer.isView(response)) {
    const bytes = new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
    return audioFromArrayBuffer(bytes.slice().buffer, fallbackMimeType);
  }
  if (response instanceof Blob) {
    return audioFromArrayBuffer(await response.arrayBuffer(), response.type || fallbackMimeType);
  }
  if (typeof response === "string" && response.trim().length > 0) {
    return audioFromBase64(response.trim(), fallbackMimeType);
  }
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  const base64 = firstString(record.audio, record.data, record.output, record.result);
  if (base64) {
    const mimeType = firstString(record.mimeType, record.mime_type, record.contentType, record.content_type) || fallbackMimeType;
    return audioFromBase64(base64, mimeType);
  }

  return null;
}

function audioFromArrayBuffer(buffer: ArrayBuffer, mimeType: string): { data: string; mimeType: string; size: number } | null {
  if (buffer.byteLength === 0) {
    return null;
  }
  const base64 = encodeBase64Bytes(buffer);
  return {
    data: `data:${mimeType};base64,${base64}`,
    mimeType,
    size: buffer.byteLength,
  };
}

function audioFromBase64(value: string, mimeType: string): { data: string; mimeType: string; size: number } | null {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/i.exec(value);
  const base64 = dataUrl ? dataUrl[2] : value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  const resolvedMimeType = dataUrl?.[1] || mimeType;
  const size = base64DecodedLength(base64);
  if (size <= 0) {
    return null;
  }
  return {
    data: `data:${resolvedMimeType};base64,${base64}`,
    mimeType: resolvedMimeType,
    size,
  };
}

function base64DecodedLength(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
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
