import type { AiSpeechCreateResult } from "@humansandmachines/gsv/protocol";
import type { PresenceRun, SpeechChunk, VoiceTimingChunk, VoiceTimingTrace } from "./types";

export function createVoiceTimingTrace(source: VoiceTimingTrace["source"], createdAt = Date.now()): VoiceTimingTrace {
  return {
    id: createTimingId(),
    source,
    createdAt,
    marks: {},
    chunks: [],
  };
}

export function markVoiceTiming(timing: VoiceTimingTrace | undefined, mark: string, at = Date.now()): void {
  if (!timing) {
    return;
  }
  timing.marks[mark] = at;
}

export function markVoiceTimingOnce(timing: VoiceTimingTrace | undefined, mark: string, at = Date.now()): void {
  if (!timing || timing.marks[mark] !== undefined) {
    return;
  }
  timing.marks[mark] = at;
}

export function recordVoiceTimingFailure(
  timing: VoiceTimingTrace | undefined,
  error: string,
  mark = "failed",
): void {
  if (!timing) {
    return;
  }
  timing.error = error;
  markVoiceTiming(timing, mark);
}

export function markRunActivity(run: PresenceRun, signal: string): void {
  markVoiceTimingOnce(run.timing, "agent_first_activity");
  markVoiceTimingOnce(run.timing, `agent_first_${signal.replace(/\W+/g, "_")}`);
}

export function recordVoiceTimingChunkReady(
  timing: VoiceTimingTrace | undefined,
  chunk: SpeechChunk,
  requestedAt: number,
  result: AiSpeechCreateResult,
): void {
  if (!timing) {
    return;
  }
  const entry = ensureVoiceTimingChunk(timing, chunk, requestedAt);
  entry.audioReadyAt = Date.now();
  entry.provider = result.provider;
  entry.model = result.model;
  if (chunk.index === 0) {
    markVoiceTiming(timing, "speech_first_audio_ready", entry.audioReadyAt);
  }
}

export function recordVoiceTimingChunkPlaybackStart(timing: VoiceTimingTrace | undefined, chunk: SpeechChunk): void {
  if (!timing) {
    return;
  }
  const now = Date.now();
  const entry = ensureVoiceTimingChunk(timing, chunk, now);
  entry.playbackStartedAt = now;
  if (chunk.index === 0) {
    markVoiceTiming(timing, "speech_first_audio_playing", now);
  }
  if (typeof timing.lastChunkEndedAt === "number") {
    entry.gapMs = Math.max(0, now - timing.lastChunkEndedAt);
  }
}

export function recordVoiceTimingChunkPlaybackEnd(timing: VoiceTimingTrace | undefined, chunk: SpeechChunk): void {
  if (!timing) {
    return;
  }
  const now = Date.now();
  const entry = ensureVoiceTimingChunk(timing, chunk, now);
  entry.playbackEndedAt = now;
  timing.lastChunkEndedAt = now;
  if (chunk.index === chunk.total - 1) {
    markVoiceTiming(timing, "speech_done", now);
  }
}

export function logVoiceTimingTrace(timing: VoiceTimingTrace | undefined, reason: string): void {
  if (!timing || timing.logged) {
    return;
  }
  timing.logged = true;
  console.debug("[presence voice timing]", voiceTimingSummary(timing, reason));
}

function ensureVoiceTimingChunk(
  timing: VoiceTimingTrace,
  chunk: SpeechChunk,
  requestedAt: number,
): VoiceTimingChunk {
  let entry = timing.chunks.find((candidate) => candidate.index === chunk.index);
  if (!entry) {
    entry = {
      index: chunk.index,
      chars: chunk.text.length,
      requestStartedAt: requestedAt,
    };
    timing.chunks.push(entry);
  }
  entry.requestStartedAt = Math.min(entry.requestStartedAt, requestedAt);
  return entry;
}

function voiceTimingSummary(timing: VoiceTimingTrace, reason: string): Record<string, unknown> {
  const marks = timing.marks;
  const chunkGaps = timing.chunks
    .map((chunk) => chunk.gapMs)
    .filter((gap): gap is number => typeof gap === "number" && Number.isFinite(gap));
  const chunks = timing.chunks
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((chunk) => ({
      index: chunk.index,
      chars: chunk.chars,
      provider: chunk.provider,
      model: chunk.model,
      synthMs: durationMs(chunk.requestStartedAt, chunk.audioReadyAt),
      gapMs: chunk.gapMs,
      playbackMs: durationMs(chunk.playbackStartedAt, chunk.playbackEndedAt),
    }));

  return {
    id: timing.id,
    reason,
    source: timing.source,
    runId: timing.runId,
    error: timing.error,
    promptChars: timing.promptChars,
    answerChars: timing.answerChars,
    vadSilenceMs: durationMs(marks.speech_last_voice, marks.segment_stopped),
    lastVoiceToTranscriptionStartMs: durationMs(marks.speech_last_voice, marks.transcription_started),
    recordingStopToTranscriptionStartMs: durationMs(marks.segment_stopped, marks.transcription_started),
    transcriptionMs: durationMs(marks.transcription_started, marks.transcription_done),
    transcriptionToAgentSendMs: durationMs(marks.transcription_done, marks.agent_send_started),
    agentDispatchMs: durationMs(marks.agent_send_started, marks.agent_send_done),
    agentWaitFirstActivityMs: durationMs(marks.agent_send_done, marks.agent_first_activity),
    agentTotalMs: durationMs(marks.agent_send_done, marks.agent_complete),
    replyToFirstAudioReadyMs: durationMs(marks.agent_complete, marks.speech_first_audio_ready),
    replyToFirstAudioPlayingMs: durationMs(marks.agent_complete, marks.speech_first_audio_playing),
    firstChunkSynthesisMs: durationMs(marks.speech_first_chunk_requested, marks.speech_first_audio_ready),
    speechPlaybackMs: durationMs(marks.speech_first_audio_playing, marks.speech_done),
    maxSpeechGapMs: chunkGaps.length > 0 ? Math.max(...chunkGaps) : undefined,
    chunkCount: timing.chunks.length,
    chunks,
  };
}

function durationMs(start: number | undefined, end: number | undefined): number | undefined {
  if (typeof start !== "number" || typeof end !== "number") {
    return undefined;
  }
  return Math.max(0, Math.round(end - start));
}

function createTimingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
