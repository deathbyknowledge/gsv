import type { PresenceState } from "../../presence/types";
import { z } from "zod";

const TRANSCRIPTION_FAILURE_PREFIX = /^Transcription failed:\s*/i;
const PROVIDER_ERROR_CODE = /\b(?:error|provider) code:\s*([a-z0-9_-]+)/i;
const TRANSCRIPTION_RETRY_MESSAGE =
  "Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model.";

function errorDetail<T>(error: T): string {
  if (error instanceof Error) {
    return error.message.trim();
  }
  const text = z.string().safeParse(error);
  if (text.success) {
    return text.data.trim();
  }
  return "";
}

export function formatTranscriptionError<T>(error: T): string {
  const detail = errorDetail(error).replace(TRANSCRIPTION_FAILURE_PREFIX, "");
  if (!detail || detail === "Unknown error") {
    return TRANSCRIPTION_RETRY_MESSAGE;
  }
  if (/no speech (?:was )?(?:transcribed|detected)/i.test(detail)) {
    return "No speech was detected. Try recording again.";
  }
  const providerCode = detail.match(PROVIDER_ERROR_CODE)?.[1];
  if (providerCode) {
    return `${TRANSCRIPTION_RETRY_MESSAGE} Provider code: ${providerCode}.`;
  }
  return TRANSCRIPTION_RETRY_MESSAGE;
}

export function normalizeTranscriptionRequestError<T>(error: T): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return error;
  }
  return new Error(formatTranscriptionError(error));
}

export function formatVoiceInputAlert(message?: string): string {
  const detail = message?.trim() ?? "";
  if (!detail) {
    return "Voice input failed";
  }
  if (TRANSCRIPTION_FAILURE_PREFIX.test(detail)) {
    return formatTranscriptionError(detail);
  }
  return detail;
}

export function liveTranscriptionTitle(state: PresenceState, note: string): string {
  if (state === "listening") {
    return note || "Stop live transcription";
  }
  if (state === "capturing") {
    return note || "Capturing speech";
  }
  if (state === "transcribing") {
    return note || "Transcribing speech";
  }
  if (state === "sending") {
    return note || "Sending transcript";
  }
  if (state === "unsupported") {
    return "Live transcription is unavailable in this browser";
  }
  if (state === "error") {
    return "Start live transcription";
  }
  return "Start live transcription";
}

export function dictationTitle(state: PresenceState, note: string): string {
  if (state === "recording") {
    return note || "Stop dictation";
  }
  if (state === "transcribing") {
    return note || "Transcribing dictation";
  }
  if (state === "unsupported") {
    return "Dictation is unavailable in this browser";
  }
  if (state === "error") {
    return "Dictate message";
  }
  return "Dictate message";
}
