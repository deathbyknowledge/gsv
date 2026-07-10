import {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  normalizeBase64Data,
  normalizeTranscriptionResponse,
  transcribeAudioWithWorkersAi,
  type AudioTranscriptionBinding,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
} from "./transcription";
import {
  DEFAULT_AUDIO_SPEECH_ENCODING,
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_TIMEOUT_MS,
  synthesizeSpeechWithWorkersAi,
  type AudioSpeechBinding,
  type AudioSpeechRequest,
  type AudioSpeechResult,
} from "./speech";
import { decodeBase64Bytes, encodeBase64Bytes } from "../shared/base64";
import { withTimeout } from "./timeout";
import { isWorkersAiProvider } from "./workers-ai";

export type CapabilityFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AiCapabilityRuntime = {
  workersAi?: AudioTranscriptionBinding & AudioSpeechBinding & ImageGenerationBinding;
  fetch?: CapabilityFetch;
};

export type ImageGenerationBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export type ImageGenerationRequest = {
  provider?: string;
  apiKey?: string;
  model?: string;
  prompt: string;
  size?: string;
  quality?: string;
  format?: string;
  timeoutMs?: number;
};

export type ImageGenerationResult = {
  data: string;
  mimeType: string;
  size: number;
  provider: string;
  model: string;
  revisedPrompt?: string;
  url?: string;
};

export const OPENAI_PROVIDER = "openai";
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const DEFAULT_OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_OPENAI_SPEECH_VOICE = "alloy";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1.5";
export const DEFAULT_IMAGE_GENERATION_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 60_000;

const OPENAI_API_BASE = "https://api.openai.com/v1";

export async function transcribeAudio(
  runtime: AiCapabilityRuntime,
  request: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult | null> {
  const provider = normalizeProvider(request.provider);
  if (isWorkersAiProvider(provider)) {
    return transcribeAudioWithWorkersAi(runtime.workersAi, {
      ...request,
      model: normalizeOptionalText(request.model) || DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
    });
  }
  if (isOpenAiProvider(provider)) {
    return transcribeAudioWithOpenAi(getFetch(runtime.fetch), {
      ...request,
      provider,
      model: normalizeOptionalText(request.model) || DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
    });
  }
  throw new Error(`Unsupported audio transcription provider: ${provider}`);
}

export async function synthesizeSpeech(
  runtime: AiCapabilityRuntime,
  request: AudioSpeechRequest & { provider?: string; apiKey?: string },
): Promise<AudioSpeechResult | null> {
  const provider = normalizeProvider(request.provider);
  if (isWorkersAiProvider(provider)) {
    return synthesizeSpeechWithWorkersAi(runtime.workersAi, {
      ...request,
      model: normalizeOptionalText(request.model) || DEFAULT_AUDIO_SPEECH_MODEL,
    });
  }
  if (isOpenAiProvider(provider)) {
    return synthesizeSpeechWithOpenAi(getFetch(runtime.fetch), {
      ...request,
      provider,
      model: normalizeOptionalText(request.model) || DEFAULT_OPENAI_SPEECH_MODEL,
      voice: normalizeOptionalText(request.voice) || DEFAULT_OPENAI_SPEECH_VOICE,
    });
  }
  throw new Error(`Unsupported speech provider: ${provider}`);
}

export async function generateImage(
  runtime: AiCapabilityRuntime,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult | null> {
  const provider = normalizeProvider(request.provider);
  if (isWorkersAiProvider(provider)) {
    return generateImageWithWorkersAi(runtime.workersAi, request);
  }
  if (isOpenAiProvider(provider)) {
    return generateImageWithOpenAi(getFetch(runtime.fetch), {
      ...request,
      provider,
      model: normalizeOptionalText(request.model) || DEFAULT_OPENAI_IMAGE_MODEL,
    });
  }
  throw new Error(`Unsupported image generation provider: ${provider}`);
}

async function transcribeAudioWithOpenAi(
  fetchFn: CapabilityFetch,
  request: AudioTranscriptionRequest & { provider: string; model: string },
): Promise<AudioTranscriptionResult | null> {
  const apiKey = requireApiKey(request.apiKey, "OpenAI audio transcription");
  const base64 = normalizeBase64Data(request.data);
  if (!base64) {
    return null;
  }

  const form = new FormData();
  const bytes = decodeBase64Bytes(base64);
  const audioBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append(
    "file",
    new Blob([audioBuffer], {
      type: normalizeAudioMimeType(request.mimeType),
    }),
    normalizeOptionalText(request.filename) || defaultAudioFilename(request.mimeType),
  );
  form.append("model", request.model);
  form.append("response_format", "json");
  if (request.mode !== "translate" && normalizeOptionalText(request.language)) {
    form.append("language", normalizeOptionalText(request.language)!);
  }
  if (normalizeOptionalText(request.prompt)) {
    form.append("prompt", normalizeOptionalText(request.prompt)!);
  }

  const endpoint = request.mode === "translate"
    ? `${OPENAI_API_BASE}/audio/translations`
    : `${OPENAI_API_BASE}/audio/transcriptions`;
  const response = await withFetchTimeout(
    fetchFn,
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    },
    request.timeoutMs,
    "OpenAI audio transcription",
  );
  await throwIfNotOk(response, "OpenAI audio transcription");
  const body = await parseResponseBody(response);
  const normalized = normalizeOpenAiTranscriptionResponse(body);
  return normalized ? { ...normalized, provider: OPENAI_PROVIDER, model: request.model } : null;
}

async function synthesizeSpeechWithOpenAi(
  fetchFn: CapabilityFetch,
  request: AudioSpeechRequest & { provider: string; apiKey?: string },
): Promise<AudioSpeechResult | null> {
  const apiKey = requireApiKey(request.apiKey, "OpenAI speech synthesis");
  const model = normalizeOptionalText(request.model) || DEFAULT_OPENAI_SPEECH_MODEL;
  const voice = normalizeOptionalText(request.voice) || DEFAULT_OPENAI_SPEECH_VOICE;
  const format = normalizeOpenAiSpeechFormat(request.encoding, request.container);
  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_AUDIO_SPEECH_TIMEOUT_MS;
  const body: Record<string, unknown> = {
    model,
    input: request.text,
    voice,
    response_format: format,
  };
  if (normalizeOptionalText(request.language)) {
    body.instructions = `Speak in ${normalizeOptionalText(request.language)}.`;
  }

  const response = await withFetchTimeout(
    fetchFn,
    `${OPENAI_API_BASE}/audio/speech`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "OpenAI speech synthesis",
  );
  await throwIfNotOk(response, "OpenAI speech synthesis");
  const audio = audioFromArrayBuffer(
    await response.arrayBuffer(),
    response.headers.get("content-type") || mimeTypeForOpenAiSpeechFormat(format),
  );
  return audio
    ? {
      ...audio,
      provider: OPENAI_PROVIDER,
      model,
      voice,
      encoding: format,
    }
    : null;
}

async function generateImageWithWorkersAi(
  ai: ImageGenerationBinding | undefined,
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult | null> {
  if (!ai) {
    return null;
  }
  const model = normalizeOptionalText(request.model) || DEFAULT_IMAGE_GENERATION_MODEL;
  const prompt = normalizeOptionalText(request.prompt);
  if (!prompt) {
    return null;
  }
  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  const response = await withTimeout(
    ai.run(model, { prompt }),
    timeoutMs,
    `Image generation timed out after ${timeoutMs}ms`,
  );
  const image = await normalizeImageGenerationResponse(response, "image/png");
  return image ? { ...image, provider: "workers-ai", model } : null;
}

async function generateImageWithOpenAi(
  fetchFn: CapabilityFetch,
  request: ImageGenerationRequest & { provider: string; model: string },
): Promise<ImageGenerationResult | null> {
  const apiKey = requireApiKey(request.apiKey, "OpenAI image generation");
  const model = normalizeOptionalText(request.model) || DEFAULT_OPENAI_IMAGE_MODEL;
  const prompt = normalizeOptionalText(request.prompt);
  if (!prompt) {
    return null;
  }

  const body: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
  };
  if (normalizeOptionalText(request.size)) {
    body.size = normalizeOptionalText(request.size);
  }
  if (normalizeOptionalText(request.quality)) {
    body.quality = normalizeOptionalText(request.quality);
  }
  const format = normalizeImageOutputFormat(request.format);
  if (format && !isDallEModel(model)) {
    body.output_format = format;
  }
  if (isDallEModel(model)) {
    body.response_format = "b64_json";
  }

  const timeoutMs = normalizePositiveNumber(request.timeoutMs) ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  const response = await withFetchTimeout(
    fetchFn,
    `${OPENAI_API_BASE}/images/generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    "OpenAI image generation",
  );
  await throwIfNotOk(response, "OpenAI image generation");
  const payload = await parseResponseBody(response);
  const image = await normalizeImageGenerationResponse(payload, mimeTypeForImageFormat(format));
  return image ? { ...image, provider: OPENAI_PROVIDER, model } : null;
}

function normalizeOpenAiTranscriptionResponse(value: unknown): Omit<AudioTranscriptionResult, "provider" | "model"> | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return null;
  }
  const workerShape = normalizeTranscriptionResponse(value);
  const duration = typeof record.duration === "number" && Number.isFinite(record.duration)
    ? record.duration
    : workerShape?.duration;
  const language = typeof record.language === "string" && record.language.trim().length > 0
    ? record.language.trim()
    : workerShape?.language;
  const segments = Array.isArray(record.segments) ? record.segments : workerShape?.segments;
  return {
    text,
    ...(duration !== undefined ? { duration } : {}),
    ...(language ? { language } : {}),
    ...(segments ? { segments } : {}),
  };
}

async function normalizeImageGenerationResponse(
  response: unknown,
  fallbackMimeType: string,
): Promise<Omit<ImageGenerationResult, "provider" | "model"> | null> {
  if (response instanceof Response) {
    return imageFromArrayBuffer(
      await response.arrayBuffer(),
      response.headers.get("content-type") || fallbackMimeType,
    );
  }
  if (response instanceof ReadableStream) {
    return imageFromArrayBuffer(await new Response(response).arrayBuffer(), fallbackMimeType);
  }
  if (response instanceof ArrayBuffer) {
    return imageFromArrayBuffer(response, fallbackMimeType);
  }
  if (ArrayBuffer.isView(response)) {
    const bytes = new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
    return imageFromArrayBuffer(bytes.slice().buffer, fallbackMimeType);
  }
  if (response instanceof Blob) {
    return imageFromArrayBuffer(await response.arrayBuffer(), response.type || fallbackMimeType);
  }
  if (typeof response === "string" && response.trim().length > 0) {
    return imageFromBase64(response.trim(), fallbackMimeType);
  }
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  if (Array.isArray(record.data) && record.data.length > 0) {
    for (const item of record.data) {
      const image = await normalizeImageGenerationResponse(item, fallbackMimeType);
      if (image) {
        const revisedPrompt = typeof item === "object" && item !== null
          ? firstString((item as Record<string, unknown>).revised_prompt)
          : undefined;
        return {
          ...image,
          ...(revisedPrompt ? { revisedPrompt } : {}),
        };
      }
    }
  }

  const base64 = firstString(record.b64_json, record.image, record.data, record.output, record.result);
  if (base64) {
    const mimeType =
      firstString(record.mimeType, record.mime_type, record.contentType, record.content_type)
      || fallbackMimeType;
    const image = imageFromBase64(base64, mimeType);
    if (!image) {
      return null;
    }
    const revisedPrompt = firstString(record.revised_prompt);
    return {
      ...image,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    };
  }

  const url = firstString(record.url);
  if (url) {
    return {
      data: "",
      mimeType: "",
      size: 0,
      url,
      ...(firstString(record.revised_prompt) ? { revisedPrompt: firstString(record.revised_prompt) } : {}),
    };
  }

  return null;
}

async function withFetchTimeout(
  fetchFn: CapabilityFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  label: string,
): Promise<Response> {
  const resolvedTimeoutMs = normalizePositiveNumber(timeoutMs) ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  return withTimeout(
    fetchFn(url, init),
    resolvedTimeoutMs,
    `${label} timed out after ${resolvedTimeoutMs}ms`,
  );
}

async function throwIfNotOk(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const text = await response.text().catch(() => "");
  const detail = text.trim() ? `: ${text.slice(0, 500)}` : "";
  throw new Error(`${label} failed with ${response.status}${detail}`);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getFetch(fetchFn: CapabilityFetch | undefined): CapabilityFetch {
  if (fetchFn) {
    return fetchFn;
  }
  if (typeof fetch === "function") {
    return fetch;
  }
  throw new Error("Fetch is not available for this AI provider");
}

function requireApiKey(value: string | undefined, label: string): string {
  const apiKey = normalizeOptionalText(value);
  if (!apiKey) {
    throw new Error(`${label} requires an API key`);
  }
  return apiKey;
}

function normalizeProvider(value: string | undefined): string {
  return normalizeOptionalText(value)?.toLowerCase() || "workers-ai";
}

function isOpenAiProvider(provider: string): boolean {
  return provider === OPENAI_PROVIDER;
}

function normalizeOpenAiSpeechFormat(encoding: unknown, container: unknown): string {
  const normalizedEncoding = normalizeOptionalText(encoding)?.toLowerCase();
  const normalizedContainer = normalizeOptionalText(container)?.toLowerCase();
  if (normalizedContainer === "wav" || normalizedEncoding === "wav") return "wav";
  if (normalizedEncoding === "linear16" || normalizedEncoding === "pcm") return "pcm";
  if (normalizedEncoding === "opus") return "opus";
  if (normalizedEncoding === "aac") return "aac";
  if (normalizedEncoding === "flac") return "flac";
  if (normalizedEncoding === "mp3") return "mp3";
  return DEFAULT_AUDIO_SPEECH_ENCODING;
}

function mimeTypeForOpenAiSpeechFormat(format: string): string {
  switch (format) {
    case "opus":
      return "audio/opus";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/L16";
    default:
      return "audio/mpeg";
  }
}

function normalizeImageOutputFormat(value: unknown): string | undefined {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (normalized === "png" || normalized === "jpeg" || normalized === "webp") {
    return normalized;
  }
  return undefined;
}

function mimeTypeForImageFormat(format: string | undefined): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function isDallEModel(model: string): boolean {
  return model.toLowerCase().startsWith("dall-e-");
}

function normalizeAudioMimeType(value: unknown): string {
  const normalized = normalizeOptionalText(value);
  return normalized && normalized.startsWith("audio/") ? normalized : "audio/webm";
}

function defaultAudioFilename(mimeType: string | undefined): string {
  const normalized = normalizeAudioMimeType(mimeType);
  if (normalized.includes("mpeg")) return "audio.mp3";
  if (normalized.includes("ogg")) return "audio.ogg";
  if (normalized.includes("wav")) return "audio.wav";
  if (normalized.includes("mp4")) return "audio.m4a";
  return "audio.webm";
}

function audioFromArrayBuffer(buffer: ArrayBuffer, mimeType: string): { data: string; mimeType: string; size: number } | null {
  if (buffer.byteLength === 0) {
    return null;
  }
  return {
    data: `data:${mimeType};base64,${encodeBase64Bytes(buffer)}`,
    mimeType,
    size: buffer.byteLength,
  };
}

function imageFromArrayBuffer(buffer: ArrayBuffer, mimeType: string): Omit<ImageGenerationResult, "provider" | "model"> | null {
  if (buffer.byteLength === 0) {
    return null;
  }
  return {
    data: `data:${mimeType};base64,${encodeBase64Bytes(buffer)}`,
    mimeType,
    size: buffer.byteLength,
  };
}

function imageFromBase64(value: string, mimeType: string): Omit<ImageGenerationResult, "provider" | "model"> | null {
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
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
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
