import { raceWithAbort } from "../shared/abort";
import { normalizeBase64Data } from "../shared/base64";
import { TimeoutError } from "./timeout";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

export type AudioTranscriptionBinding = {
  run(
    model: string,
    input: JsonObject,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue>;
};

export type TranscriptionMode = "transcribe" | "translate";

export type AudioTranscriptionRequest = {
  data: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  mimeType?: string;
  filename?: string;
  timeoutMs?: number;
  language?: string;
  prompt?: string;
  mode?: TranscriptionMode;
  vadFilter?: boolean;
  conditionOnPreviousText?: boolean;
  signal?: AbortSignal;
};

export type AudioTranscriptionResult = {
  text: string;
  duration?: number;
  language?: string;
  segments?: JsonValue[];
  provider: string;
  model: string;
};

export const DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
export const DEFAULT_AUDIO_TRANSCRIPTION_TIMEOUT_MS = 30_000;

export async function transcribeAudioWithWorkersAi(
  ai: AudioTranscriptionBinding | undefined,
  request: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult | null> {
  if (request.signal?.aborted) {
    throw request.signal.reason ?? new Error("Transcription cancelled");
  }
  if (!ai) {
    return null;
  }

  const model = request.model || DEFAULT_AUDIO_TRANSCRIPTION_MODEL;
  const input: JsonObject = {
    audio: normalizeBase64Data(request.data),
    task: request.mode || "transcribe",
    vad_filter: request.vadFilter ?? true,
    condition_on_previous_text: request.conditionOnPreviousText ?? false,
  };
  if (request.language) {
    input.language = request.language;
  }
  if (request.prompt) {
    input.initial_prompt = request.prompt;
  }

  const timeoutMs = normalizeTranscriptionTimeout(request.timeoutMs);
  const abort = createTranscriptionAbort(request.signal, timeoutMs);
  try {
    const response = abort.signal
      ? await raceWithAbort(ai.run(model, input, { signal: abort.signal }), abort.signal)
      : await ai.run(model, input);
    const result = normalizeTranscriptionResponse(response);
    return result ? { ...result, provider: "workers-ai", model } : null;
  } finally {
    abort.clear();
  }
}

function normalizeTranscriptionTimeout(value: number | undefined): number | undefined {
  const parsed = z.number().safeParse(value);
  return parsed.success && Number.isFinite(parsed.data) && parsed.data > 0 ? parsed.data : undefined;
}

type TranscriptionAbort = { signal?: AbortSignal; clear: () => void };

function createTranscriptionAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): TranscriptionAbort {
  const timeoutController = timeoutMs === undefined ? null : new AbortController();
  const timeout = timeoutController && timeoutMs !== undefined
    ? setTimeout(() => {
      timeoutController.abort(new TimeoutError(`Transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs)
    : null;
  const signals = [callerSignal, timeoutController?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return {
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    clear: () => {
      if (timeout !== null) clearTimeout(timeout);
    },
  };
}

export function normalizeTranscriptionResponse(value: JsonValue): Omit<AudioTranscriptionResult, "provider" | "model"> | null {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  const textValue = z.string().safeParse(record.text);
  const text = textValue.success ? textValue.data.trim() : "";
  if (!text) {
    return null;
  }

  const infoResult = jsonObjectSchema.safeParse(record.transcription_info);
  const info = infoResult.success ? infoResult.data : undefined;
  const durationValue = z.number().safeParse(info?.duration);
  const duration = durationValue.success && Number.isFinite(durationValue.data)
    ? durationValue.data
    : undefined;
  const languageValue = z.string().safeParse(info?.language);
  const language = languageValue.success && languageValue.data.trim().length > 0
    ? languageValue.data.trim()
    : undefined;
  const segments = Array.isArray(record.segments)
    ? record.segments
    : Array.isArray(info?.segments)
      ? info.segments
      : undefined;

  const result: Omit<AudioTranscriptionResult, "provider" | "model"> = { text };
  if (duration !== undefined) result.duration = duration;
  if (language) result.language = language;
  if (segments) result.segments = segments;
  return result;
}
