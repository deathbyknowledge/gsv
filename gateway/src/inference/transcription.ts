import { raceWithAbort } from "../shared/abort";
import { normalizeBase64Data } from "../shared/base64";
import { TimeoutError } from "./timeout";

export type AudioTranscriptionBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
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
  segments?: unknown[];
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
  const input: Record<string, unknown> = {
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
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function createTranscriptionAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; clear: () => void } {
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

export function normalizeTranscriptionResponse(value: unknown): Omit<AudioTranscriptionResult, "provider" | "model"> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return null;
  }

  const info = record.transcription_info && typeof record.transcription_info === "object"
    ? record.transcription_info as Record<string, unknown>
    : null;
  const duration = typeof info?.duration === "number" && Number.isFinite(info.duration)
    ? info.duration
    : undefined;
  const language = typeof info?.language === "string" && info.language.trim().length > 0
    ? info.language.trim()
    : undefined;
  const segments = Array.isArray(record.segments)
    ? record.segments
    : Array.isArray(info?.segments)
      ? info.segments
      : undefined;

  return {
    text,
    ...(duration !== undefined ? { duration } : {}),
    ...(language ? { language } : {}),
    ...(segments ? { segments } : {}),
  };
}
