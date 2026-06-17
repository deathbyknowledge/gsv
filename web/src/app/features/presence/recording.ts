import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import {
  canUseAmbientMode,
  canUseBrowserVoiceRecorder,
  createAudioContext,
  currentRms,
  requestVoiceStream,
  selectVoiceRecorderMimeType,
} from "./audio";
import {
  AMBIENT_END_SILENCE_MS,
  AMBIENT_RMS_THRESHOLD,
  AMBIENT_SAMPLE_MS,
  AMBIENT_START_MS,
  MAX_AMBIENT_SEGMENT_MS,
  MAX_PUSH_RECORDING_MS,
  VOICE_AUDIO_BITS_PER_SECOND,
} from "./constants";
import { formatElapsed, formatError } from "./display";
import type { PresenceState } from "./types";

export type AmbientSegment = {
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  lastVoiceAt: number;
  stoppedAt: number;
};

type PresenceRecorderOptions = {
  isConnected(): boolean;
  isDestroyed(): boolean;
  isSpeechOutputPlaying(): boolean;
  cancelSpeechOutput(): void;
  activeRunCount(): number;
  hasAmbientPendingJobs(): boolean;
  ambientIdleNote(): string;
  setPanelOpen(open: boolean): void;
  setNote(note: string): void;
  getState(): PresenceState;
  setState(state: PresenceState, message?: string): void;
  transcribe(blob: Blob, mimeType: string, startedAt?: number): Promise<AiTranscriptionCreateResult>;
  onPushTranscribed(result: AiTranscriptionCreateResult): void;
  onAmbientSegment(segment: AmbientSegment): void | Promise<void>;
};

export type PresenceRecorder = {
  isAmbientActive(): boolean;
  isAmbientCapturing(): boolean;
  startPushRecording(): Promise<void>;
  stopPushRecording(): void;
  cleanupPushRecorder(): void;
  startAmbient(): Promise<void>;
  stopAmbient(): void;
  destroy(): void;
};

export function createPresenceRecorder(options: PresenceRecorderOptions): PresenceRecorder {
  let pushRecorder: MediaRecorder | null = null;
  let pushStream: MediaStream | null = null;
  let pushChunks: Blob[] = [];
  let pushStartedAt = 0;
  let pushTimer: number | null = null;

  let ambientStream: MediaStream | null = null;
  let ambientMimeType = "audio/webm";
  let ambientContext: AudioContext | null = null;
  let ambientSource: MediaStreamAudioSourceNode | null = null;
  let ambientAnalyser: AnalyserNode | null = null;
  let ambientSamples: Float32Array<ArrayBuffer> | null = null;
  let ambientTimer: number | null = null;
  let ambientSegmentRecorder: MediaRecorder | null = null;
  let ambientSegmentChunks: Blob[] = [];
  let ambientSpeechActive = false;
  let ambientSpeechMs = 0;
  let ambientLastVoiceAt = 0;
  let ambientSegmentStartedAt = 0;

  function isAmbientActive(): boolean {
    return ambientStream !== null;
  }

  function isAmbientCapturing(): boolean {
    return ambientSpeechActive;
  }

  async function startPushRecording(): Promise<void> {
    if (!canUseBrowserVoiceRecorder() || !options.isConnected()) {
      options.setState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    options.cancelSpeechOutput();
    cleanupPushRecorder();
    options.setPanelOpen(true);
    options.setNote("");
    options.setState("recording", "Requesting microphone");
    try {
      const stream = await requestVoiceStream();
      if (options.isDestroyed()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = selectVoiceRecorderMimeType();
      const recorderOptions: MediaRecorderOptions = { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND };
      if (mimeType) {
        recorderOptions.mimeType = mimeType;
      }
      pushRecorder = new MediaRecorder(stream, recorderOptions);
      pushStream = stream;
      pushChunks = [];
      pushStartedAt = Date.now();

      pushRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          pushChunks.push(event.data);
        }
      };
      pushRecorder.onerror = () => {
        cleanupPushRecorder();
        options.setNote("");
        options.setState("error", "Voice recording failed");
      };
      pushRecorder.onstop = () => {
        void finishPushRecording();
      };
      pushRecorder.start(1000);
      pushTimer = window.setInterval(() => {
        const elapsedMs = Date.now() - pushStartedAt;
        options.setNote(`Recording ${formatElapsed(elapsedMs)}`);
        options.setState("recording");
        if (elapsedMs >= MAX_PUSH_RECORDING_MS && pushRecorder?.state === "recording") {
          stopPushRecording();
        }
      }, 250);
      options.setNote("Recording 0:00");
      options.setState("recording");
    } catch (error) {
      cleanupPushRecorder();
      options.setNote("");
      options.setState("error", "Microphone failed: " + formatError(error));
    }
  }

  function stopPushRecording(): void {
    const current = pushRecorder;
    if (!current || current.state === "inactive") {
      cleanupPushRecorder();
      options.setState("idle");
      return;
    }
    clearPushTimer();
    options.setNote("Transcribing");
    options.setState("transcribing");
    current.stop();
  }

  async function finishPushRecording(): Promise<void> {
    clearPushTimer();
    const chunks = pushChunks.slice();
    const mimeType = pushRecorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/webm";
    cleanupPushRecorder();
    if (options.isDestroyed()) {
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      options.setNote("");
      options.setState("error", "No audio was captured");
      return;
    }

    options.setNote("Transcribing");
    options.setState("transcribing");
    try {
      const result = await options.transcribe(blob, mimeType);
      options.onPushTranscribed(result);
    } catch (error) {
      options.setNote("");
      options.setState("error", "Transcription failed: " + formatError(error));
    }
  }

  async function startAmbient(): Promise<void> {
    if (!canUseAmbientMode() || !options.isConnected()) {
      options.setState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    stopAmbient();
    options.setPanelOpen(true);
    options.setNote("Requesting microphone");
    options.setState("listening");
    try {
      const stream = await requestVoiceStream();
      if (options.isDestroyed()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = selectVoiceRecorderMimeType();
      ambientStream = stream;
      ambientMimeType = mimeType || "audio/webm";
      ambientContext = createAudioContext();
      ambientSource = ambientContext.createMediaStreamSource(stream);
      ambientAnalyser = ambientContext.createAnalyser();
      ambientAnalyser.fftSize = 2048;
      ambientSource.connect(ambientAnalyser);
      ambientSamples = new Float32Array(ambientAnalyser.fftSize) as Float32Array<ArrayBuffer>;

      ambientTimer = window.setInterval(tickAmbientVad, AMBIENT_SAMPLE_MS);
      options.setNote("Mind is listening");
      options.setState("listening", "Listening");
    } catch (error) {
      stopAmbient();
      options.setNote("");
      options.setState("error", "Microphone failed: " + formatError(error));
    }
  }

  function stopAmbient(): void {
    options.cancelSpeechOutput();
    clearAmbientTimer();
    stopAmbientSegment("stop");
    ambientSpeechActive = false;
    ambientSpeechMs = 0;
    ambientLastVoiceAt = 0;
    ambientSegmentStartedAt = 0;

    ambientSource?.disconnect();
    ambientSource = null;
    ambientAnalyser?.disconnect();
    ambientAnalyser = null;
    ambientSamples = null;
    const context = ambientContext;
    ambientContext = null;
    void context?.close().catch(() => {});
    const stream = ambientStream;
    ambientStream = null;
    stream?.getTracks().forEach((track) => track.stop());
    const state = options.getState();
    if (state === "listening" || state === "capturing" || state === "transcribing" || state === "sending") {
      const activeRuns = options.activeRunCount();
      options.setNote(activeRuns > 0 ? options.ambientIdleNote() : "");
      options.setState("idle", activeRuns > 0 ? "Mind working" : "Listening paused");
    }
  }

  function tickAmbientVad(): void {
    if (!ambientAnalyser || !ambientSamples || !ambientStream) {
      return;
    }
    const now = Date.now();
    const rms = currentRms(ambientAnalyser, ambientSamples);
    const speechNow = rms >= AMBIENT_RMS_THRESHOLD;

    if (options.isSpeechOutputPlaying()) {
      ambientSpeechMs = 0;
      if (!ambientSpeechActive) {
        options.setNote("Speaking");
        options.setState("listening");
        return;
      }
    }

    if (speechNow) {
      ambientSpeechMs += AMBIENT_SAMPLE_MS;
      ambientLastVoiceAt = now;
      if (!ambientSpeechActive && ambientSpeechMs >= AMBIENT_START_MS) {
        startAmbientSegment(now - ambientSpeechMs);
      }
    } else {
      ambientSpeechMs = 0;
    }

    if (!ambientSpeechActive) {
      options.setNote(options.ambientIdleNote());
      options.setState(options.hasAmbientPendingJobs() ? "transcribing" : "listening");
      return;
    }

    const segmentMs = now - ambientSegmentStartedAt;
    const silenceMs = now - ambientLastVoiceAt;
    options.setNote(`Capturing ${formatElapsed(segmentMs)}`);
    options.setState("capturing");
    if (silenceMs >= AMBIENT_END_SILENCE_MS || segmentMs >= MAX_AMBIENT_SEGMENT_MS) {
      stopAmbientSegment(silenceMs >= AMBIENT_END_SILENCE_MS ? "silence" : "max");
    }
  }

  function startAmbientSegment(startedAt: number): void {
    if (!ambientStream || ambientSegmentRecorder) {
      return;
    }
    options.cancelSpeechOutput();
    const recorderOptions: MediaRecorderOptions = { audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND };
    if (ambientMimeType) {
      recorderOptions.mimeType = ambientMimeType;
    }
    const recorder = new MediaRecorder(ambientStream, recorderOptions);
    ambientSegmentRecorder = recorder;
    ambientSegmentChunks = [];
    ambientSegmentStartedAt = startedAt;
    ambientSpeechActive = true;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        ambientSegmentChunks.push(event.data);
      }
    };
    recorder.onerror = () => {
      ambientSegmentRecorder = null;
      ambientSegmentChunks = [];
      ambientSpeechActive = false;
      options.setNote("");
      options.setState("error", "Ambient recording failed");
    };
    recorder.onstop = () => {
      const chunks = ambientSegmentChunks.slice();
      const mimeType = recorder.mimeType || ambientMimeType;
      const segmentStartedAt = ambientSegmentStartedAt || Date.now();
      const segmentStoppedAt = Date.now();
      const lastVoiceAt = ambientLastVoiceAt || segmentStoppedAt;
      ambientSegmentRecorder = null;
      ambientSegmentChunks = [];
      ambientSegmentStartedAt = 0;
      void options.onAmbientSegment({
        chunks,
        mimeType,
        startedAt: segmentStartedAt,
        lastVoiceAt,
        stoppedAt: segmentStoppedAt,
      });
    };
    recorder.start(250);
    options.setNote("Capturing speech");
    options.setState("capturing");
  }

  function stopAmbientSegment(reason: "silence" | "max" | "stop"): void {
    const recorder = ambientSegmentRecorder;
    ambientSpeechActive = false;
    ambientSpeechMs = 0;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    if (reason === "max") {
      options.setNote("Segment reached time limit");
    } else if (reason === "stop") {
      options.setNote("Stopping ambient");
    } else {
      options.setNote("Speech ended");
    }
    options.setState("transcribing");
    try {
      recorder.stop();
    } catch {
      ambientSegmentRecorder = null;
      ambientSegmentChunks = [];
    }
  }

  function cleanupPushRecorder(): void {
    clearPushTimer();
    const current = pushRecorder;
    pushRecorder = null;
    pushChunks = [];
    pushStartedAt = 0;
    if (current && current.state !== "inactive") {
      current.ondataavailable = null;
      current.onerror = null;
      current.onstop = null;
      try {
        current.stop();
      } catch {
        // Recorder state can change between the state check and stop call.
      }
    }
    const stream = pushStream;
    pushStream = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  function clearPushTimer(): void {
    if (pushTimer !== null) {
      window.clearInterval(pushTimer);
      pushTimer = null;
    }
  }

  function clearAmbientTimer(): void {
    if (ambientTimer !== null) {
      window.clearInterval(ambientTimer);
      ambientTimer = null;
    }
  }

  return {
    isAmbientActive,
    isAmbientCapturing,
    startPushRecording,
    stopPushRecording,
    cleanupPushRecorder,
    startAmbient,
    stopAmbient,
    destroy() {
      cleanupPushRecorder();
      stopAmbient();
    },
  };
}
