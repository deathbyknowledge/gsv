import { normalizeSpeechText } from "@humansandmachines/gsv/protocol";
import type { AiSpeechCreateResult } from "@humansandmachines/gsv/protocol";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { SPEECH_PREFETCH_CONCURRENCY } from "./constants";
import { formatError } from "./display";
import { chunkSpeechText, selectSpeechPrefix } from "./speechText";
import type { PresenceRun, SpeechChunk, VoiceTimingTrace } from "./types";
import {
  logVoiceTimingTrace,
  markVoiceTiming,
  recordVoiceTimingChunkPlaybackEnd,
  recordVoiceTimingChunkPlaybackStart,
  recordVoiceTimingChunkReady,
  recordVoiceTimingFailure,
} from "./voiceTiming";

type PresenceSpeechClient = Pick<GSVClient, "ai" | "isConnected">;

type PresenceSpeechOutputOptions = {
  gatewayClient: PresenceSpeechClient;
  getSpeakReplies(): boolean;
  isDestroyed(): boolean;
  setSpeechStatus(message: string): void;
};

export type PresenceSpeechOutput = {
  isPlaying(): boolean;
  cancel(message?: string): void;
  speakReply(text: string, options?: { force?: boolean; interrupt?: boolean; timing?: VoiceTimingTrace }): Promise<void>;
  queueRunSpeechFromAnswer(run: PresenceRun, final: boolean): boolean;
  finalizeRunSpeech(run: PresenceRun): boolean;
};

export function createPresenceSpeechOutput(options: PresenceSpeechOutputOptions): PresenceSpeechOutput {
  const { gatewayClient, getSpeakReplies, isDestroyed, setSpeechStatus } = options;
  let speechAttempt = 0;
  let speechAudio: HTMLAudioElement | null = null;
  let speechPlaybackCancel: (() => void) | null = null;
  let speechQueue: Promise<void> = Promise.resolve();

  function isPlaying(): boolean {
    return speechAudio !== null && !speechAudio.paused && !speechAudio.ended;
  }

  function cancel(message?: string): void {
    speechAttempt += 1;
    const cancelPlayback = speechPlaybackCancel;
    speechPlaybackCancel = null;
    const audio = speechAudio;
    speechAudio = null;
    if (audio) {
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      if (audio.src.startsWith("blob:")) {
        URL.revokeObjectURL(audio.src);
      }
      audio.removeAttribute("src");
      audio.load();
    }
    cancelPlayback?.();
    if (message) {
      setSpeechStatus(message);
    }
  }

  async function speakReply(
    text: string,
    options?: { force?: boolean; interrupt?: boolean; timing?: VoiceTimingTrace },
  ): Promise<void> {
    if (!options?.force && !getSpeakReplies()) {
      logVoiceTimingTrace(options?.timing, "speech-disabled");
      return;
    }
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    if (!gatewayClient.isConnected()) {
      setSpeechStatus("Speech unavailable while disconnected");
      return;
    }
    const speechText = normalizeSpeechText(normalized);
    if (!speechText) {
      logVoiceTimingTrace(options?.timing, "speech-empty");
      return;
    }
    const chunks = chunkSpeechText(speechText);
    if (chunks.length === 0) {
      logVoiceTimingTrace(options?.timing, "speech-empty");
      return;
    }
    if (options?.interrupt === false && isPlaying()) {
      return;
    }
    if (options?.interrupt !== false) {
      cancel();
    }
    const attempt = ++speechAttempt;

    try {
      const pendingSpeech = new Map<number, Promise<AiSpeechCreateResult>>();
      let nextRequestIndex = 0;
      const ensurePrefetch = () => {
        while (
          nextRequestIndex < chunks.length
          && pendingSpeech.size < SPEECH_PREFETCH_CONCURRENCY
        ) {
          const chunk = chunks[nextRequestIndex];
          pendingSpeech.set(chunk.index, requestSpeechChunk(chunk, attempt, options?.timing));
          nextRequestIndex += 1;
        }
      };
      ensurePrefetch();
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (attempt !== speechAttempt) {
          return;
        }
        setSpeechStatus(speechChunkStatus("Generating speech", chunk));
        const result = await pendingSpeech.get(chunk.index);
        if (attempt !== speechAttempt) {
          return;
        }
        if (!result) {
          throw new Error("Speech generation was not queued");
        }
        pendingSpeech.delete(chunk.index);
        ensurePrefetch();
        await playSpeechChunk(result, chunk, attempt, options?.timing);
      }
      if (attempt === speechAttempt) {
        setSpeechStatus(getSpeakReplies() ? "Speak replies on" : "Speech off");
        logVoiceTimingTrace(options?.timing, "speech-complete");
      }
    } catch (error) {
      if (attempt !== speechAttempt) {
        return;
      }
      speechAudio = null;
      const message = formatError(error);
      setSpeechStatus("Speech failed: " + message);
      recordVoiceTimingFailure(options?.timing, message, "speech_failed");
      logVoiceTimingTrace(options?.timing, "speech-failed");
    }
  }

  function queueRunSpeechFromAnswer(run: PresenceRun, final: boolean): boolean {
    if (!getSpeakReplies() || !run.answer.trim()) {
      return false;
    }
    let queued = false;
    for (;;) {
      const segment = nextRunSpeechSegment(run, final);
      if (!segment) {
        break;
      }
      const speechText = normalizeSpeechText(segment.text);
      if (!speechText) {
        continue;
      }
      const chunkIndex = run.speechChunkIndex ?? 0;
      run.speechChunkIndex = chunkIndex + 1;
      run.speechStarted = true;
      queued = true;
      enqueueSpeechChunk({
        text: speechText,
        index: chunkIndex,
        total: chunkIndex + 1,
      }, run.timing);
    }
    return queued;
  }

  function finalizeRunSpeech(run: PresenceRun): boolean {
    const queued = queueRunSpeechFromAnswer(run, true);
    if (!run.speechStarted) {
      return queued;
    }
    const timing = run.timing;
    speechQueue = speechQueue
      .catch(() => {})
      .then(() => logVoiceTimingTrace(timing, "speech-complete"));
    void speechQueue;
    return true;
  }

  function nextRunSpeechSegment(run: PresenceRun, final: boolean): { text: string } | null {
    const cursor = run.speechCursor ?? 0;
    const pending = run.answer.slice(cursor);
    const prefix = selectSpeechPrefix(pending, final, !run.speechStarted);
    if (!prefix) {
      return null;
    }
    run.speechCursor = cursor + prefix.consumed;
    return { text: prefix.text };
  }

  function enqueueSpeechChunk(chunk: SpeechChunk, timing?: VoiceTimingTrace): void {
    speechQueue = speechQueue
      .catch(() => {})
      .then(() => speakQueuedSpeechChunk(chunk, timing));
    void speechQueue;
  }

  async function speakQueuedSpeechChunk(chunk: SpeechChunk, timing?: VoiceTimingTrace): Promise<void> {
    if (isDestroyed() || !getSpeakReplies()) {
      return;
    }
    if (!gatewayClient.isConnected()) {
      setSpeechStatus("Speech unavailable while disconnected");
      return;
    }
    const attempt = ++speechAttempt;
    try {
      setSpeechStatus(speechChunkStatus("Generating speech", chunk));
      const result = await requestSpeechChunk(chunk, attempt, timing);
      if (attempt !== speechAttempt) {
        return;
      }
      await playSpeechChunk(result, chunk, attempt, timing);
      if (attempt === speechAttempt) {
        setSpeechStatus(getSpeakReplies() ? "Speak replies on" : "Speech off");
      }
    } catch (error) {
      if (attempt !== speechAttempt) {
        return;
      }
      speechAudio = null;
      const message = formatError(error);
      setSpeechStatus("Speech failed: " + message);
      recordVoiceTimingFailure(timing, message, "speech_failed");
    }
  }

  async function requestSpeechChunk(
    chunk: SpeechChunk,
    attempt: number,
    timing?: VoiceTimingTrace,
  ): Promise<AiSpeechCreateResult> {
    if (attempt !== speechAttempt) {
      throw new Error("Speech cancelled");
    }
    const requestedAt = Date.now();
    markVoiceTiming(timing, chunk.index === 0 ? "speech_first_chunk_requested" : "speech_chunk_requested");
    const result = await gatewayClient.ai.speech.create({
      text: chunk.text,
    });
    recordVoiceTimingChunkReady(timing, chunk, requestedAt, result);
    return result;
  }

  function playSpeechChunk(
    result: AiSpeechCreateResult,
    chunk: SpeechChunk,
    attempt: number,
    timing?: VoiceTimingTrace,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (attempt !== speechAttempt) {
        resolve();
        return;
      }
      if (result.skipped || result.audio.size <= 0 || !result.audio.data) {
        resolve();
        return;
      }

      const audio = new Audio(result.audio.data);
      let settled = false;
      let cancelPlayback: (() => void) | null = null;
      const cleanup = () => {
        audio.onplay = null;
        audio.onended = null;
        audio.onerror = null;
        if (speechAudio === audio) {
          speechAudio = null;
        }
        if (audio.src.startsWith("blob:")) {
          URL.revokeObjectURL(audio.src);
        }
        if (speechPlaybackCancel === cancelPlayback) {
          speechPlaybackCancel = null;
        }
      };
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      cancelPlayback = () => finish();
      speechAudio = audio;
      speechPlaybackCancel = cancelPlayback;
      audio.onplay = () => {
        if (attempt === speechAttempt) {
          recordVoiceTimingChunkPlaybackStart(timing, chunk);
          setSpeechStatus(speechChunkStatus("Speaking", chunk));
        }
      };
      audio.onended = () => {
        recordVoiceTimingChunkPlaybackEnd(timing, chunk);
        finish();
      };
      audio.onerror = () => finish(new Error("Speech playback failed"));
      setSpeechStatus(speechChunkStatus("Starting speech", chunk));
      void audio.play().catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  return {
    isPlaying,
    cancel,
    speakReply,
    queueRunSpeechFromAnswer,
    finalizeRunSpeech,
  };
}

function speechChunkStatus(prefix: string, chunk: SpeechChunk): string {
  return chunk.total > 1 ? `${prefix} ${chunk.index + 1}/${chunk.total}` : prefix;
}
