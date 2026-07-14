import { describe, expect, it } from "vitest";
import {
  dictationTitle,
  formatTranscriptionError,
  formatVoiceInputAlert,
  liveTranscriptionTitle,
  normalizeTranscriptionRequestError,
} from "./voiceFeedback";

describe("chat voice feedback", () => {
  it("turns an opaque speech-provider code into an actionable transcription error", () => {
    expect(formatTranscriptionError(new Error("Error code: 1031"))).toBe(
      "Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model. Provider code: 1031.",
    );
  });

  it("normalizes the recorder's transcription prefix without duplicating it", () => {
    expect(formatVoiceInputAlert("Transcription failed: Error code: 1031")).toBe(
      "Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model. Provider code: 1031.",
    );
    expect(formatVoiceInputAlert(
      "Transcription failed: Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model. Provider code: 1031.",
    )).toBe(
      "Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model. Provider code: 1031.",
    );
  });

  it("preserves cancellation errors at the transcription request boundary", () => {
    const cancellation = new Error("Dictation stopped");
    cancellation.name = "AbortError";

    expect(normalizeTranscriptionRequestError(cancellation)).toBe(cancellation);
  });

  it("gives empty transcription results a specific retry message", () => {
    expect(formatTranscriptionError(new Error("No speech was transcribed"))).toBe(
      "No speech was detected. Try recording again.",
    );
  });

  it("does not rewrite non-transcription voice errors", () => {
    expect(formatVoiceInputAlert("Microphone failed: Permission denied")).toBe(
      "Microphone failed: Permission denied",
    );
  });

  it("keeps transcription errors entirely out of voice control titles", () => {
    expect(liveTranscriptionTitle("error", "Error code: 1031")).toBe(
      "Start live transcription",
    );
    expect(dictationTitle("error", "Error code: 1031")).toBe(
      "Dictate message",
    );
  });

  it("does not expose arbitrary provider details in transcription alerts", () => {
    expect(formatTranscriptionError(new Error("internal provider routing detail"))).toBe(
      "Audio transcription failed. Try recording again. If it keeps happening, check the configured speech model.",
    );
  });
});
