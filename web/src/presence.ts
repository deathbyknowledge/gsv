import { normalizeSpeechText } from "@humansandmachines/gsv/protocol";
import type { AiSpeechCreateResult, AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import type { GatewayClientLike } from "./app/services/gateway/gatewayClient";
import {
  localSpeechSupported,
  synthesizeLocalSpeech,
} from "./local-tts";

type PresenceOptions = {
  rootNode: HTMLElement;
  gatewayClient: GatewayClientLike;
};

type PresenceMode = "ambient" | "push";
type PresenceState =
  | "idle"
  | "listening"
  | "capturing"
  | "recording"
  | "transcribing"
  | "sending"
  | "unsupported"
  | "error";

type PresenceLogStatus =
  | "Sending"
  | "Queued"
  | "Working"
  | "Responding"
  | "Using tools"
  | "Needs approval"
  | "Done"
  | "Stopped"
  | "Failed";

type PresenceSendResult = {
  runId: string;
  queued?: boolean;
};

type PresenceRun = {
  row: HTMLElement | null;
  prompt: string;
  answer: string;
  status: PresenceLogStatus;
  updatedAt: number;
  timing?: VoiceTimingTrace;
  speechCursor?: number;
  speechChunkIndex?: number;
  speechStarted?: boolean;
};

type BufferedRunSignal = {
  signal: string;
  payload: unknown;
  receivedAt: number;
};

type SpeechChunk = {
  text: string;
  index: number;
  total: number;
};

type VoiceTimingTrace = {
  id: string;
  source: "ambient" | "manual";
  createdAt: number;
  marks: Record<string, number>;
  chunks: VoiceTimingChunk[];
  runId?: string;
  promptChars?: number;
  answerChars?: number;
  error?: string;
  lastChunkEndedAt?: number;
  logged?: boolean;
};

type VoiceTimingChunk = {
  index: number;
  chars: number;
  requestStartedAt: number;
  audioReadyAt?: number;
  playbackStartedAt?: number;
  playbackEndedAt?: number;
  provider?: string;
  model?: string;
  gapMs?: number;
};

type PendingInterimSpeech = {
  timer: number;
  text: string;
  key: string;
};

type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

const VOICE_AUDIO_BITS_PER_SECOND = 128000;
const MAX_PUSH_RECORDING_MS = 2 * 60 * 1000;
const MAX_AMBIENT_SEGMENT_MS = 45 * 1000;
const AMBIENT_SAMPLE_MS = 100;
const AMBIENT_START_MS = 100;
const AMBIENT_END_SILENCE_MS = 1100;
const AMBIENT_MIN_SEGMENT_MS = 450;
const AMBIENT_MIN_SEGMENT_BYTES = 900;
const AMBIENT_RMS_THRESHOLD = 0.018;
const SPEECH_FIRST_CHUNK_MIN_CHARS = 48;
const SPEECH_FIRST_CHUNK_TARGET_CHARS = 90;
const SPEECH_FIRST_CHUNK_MAX_CHARS = 120;
const SPEECH_CHUNK_MAX_CHARS = 420;
const SPEECH_PREFETCH_CONCURRENCY = 3;
const INTERIM_SPEECH_DELAY_MS = 650;
const INTERIM_SPEECH_MAX_CHARS = 220;
const INTERIM_SPEECH_COOLDOWN_MS = 7000;
const RUN_SIGNAL_BUFFER_TTL_MS = 60 * 1000;
const MAX_BUFFERED_RUN_SIGNALS = 64;
const PRESENCE_MODE_STORAGE_KEY = "gsv.presence.mode";
const SPEAK_REPLIES_STORAGE_KEY = "gsv.presence.speakReplies";
const PRESENCE_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

export function createPresenceControl(options: PresenceOptions): { destroy(): void } {
  const { rootNode, gatewayClient } = options;
  const toggles = Array.from(rootNode.querySelectorAll<HTMLButtonElement>("[data-presence-toggle]"));
  const panel = rootNode.querySelector<HTMLElement>("[data-presence-panel]");
  const closeButton = rootNode.querySelector<HTMLButtonElement>("[data-presence-close]");
  const listenButton = rootNode.querySelector<HTMLButtonElement>("[data-presence-listen]");
  const sendButton = rootNode.querySelector<HTMLButtonElement>("[data-presence-send]");
  const clearButton = rootNode.querySelector<HTMLButtonElement>("[data-presence-clear]");
  const statusNode = rootNode.querySelector<HTMLElement>("[data-presence-status]");
  const compactStatusNodes = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-presence-compact-status]"));
  const transcriptNode = rootNode.querySelector<HTMLTextAreaElement>("[data-presence-transcript]");
  const noteNode = rootNode.querySelector<HTMLElement>("[data-presence-interim]");
  const logNode = rootNode.querySelector<HTMLElement>("[data-presence-log]");
  const speakNode = rootNode.querySelector<HTMLInputElement>("[data-presence-speak]");
  const speakTestNode = rootNode.querySelector<HTMLButtonElement>("[data-presence-speak-test]");
  const speechStatusNode = rootNode.querySelector<HTMLElement>("[data-presence-speech-status]");
  const activityNode = rootNode.querySelector<HTMLButtonElement>("[data-presence-activity]");
  const activityStatusNode = rootNode.querySelector<HTMLElement>("[data-presence-activity-status]");
  const activityBodyNode = rootNode.querySelector<HTMLElement>("[data-presence-activity-body]");
  const modeButtons = Array.from(rootNode.querySelectorAll<HTMLButtonElement>("[data-presence-mode]"));

  if (!panel || toggles.length === 0 || !listenButton || !sendButton || !clearButton || !statusNode || !transcriptNode) {
    return { destroy() {} };
  }

  const panelNode = panel;
  const listenNode = listenButton;
  const sendNode = sendButton;
  const clearNode = clearButton;
  const statusTextNode = statusNode;
  const transcriptInputNode = transcriptNode;

  let mode: PresenceMode = loadPresenceModePreference();
  let state: PresenceState = canUseBrowserVoiceRecorder() ? "idle" : "unsupported";
  let note = "";
  let panelOpen = false;
  let destroyed = false;
  let lastSentText = "";
  let latestRunId: string | null = null;
  let activityHideTimer: number | null = null;
  let speakReplies = loadSpeakRepliesPreference();
  let speechAttempt = 0;
  let speechAudio: HTMLAudioElement | null = null;
  let speechPlaybackCancel: (() => void) | null = null;
  let speechQueue: Promise<void> = Promise.resolve();
  let lastInterimSpeechKey = "";
  let lastInterimSpeechAt = 0;
  const activeRuns = new Map<string, PresenceRun>();
  const bufferedRunSignals = new Map<string, BufferedRunSignal[]>();
  const pendingInterimSpeech = new Map<string, PendingInterimSpeech>();

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
  let ambientPendingJobs = 0;

  function setPanelOpen(open: boolean): void {
    panelOpen = open;
    panelNode.hidden = !open;
    for (const toggle of toggles) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (activityNode) {
      activityNode.setAttribute("aria-expanded", open ? "true" : "false");
      activityNode.classList.toggle("is-expanded", open);
    }
    if (activeRuns.size === 0 && activityHideTimer === null) {
      renderIdlePresenceActivity();
    }
  }

  function setMode(nextMode: PresenceMode): void {
    if (mode === nextMode) {
      return;
    }
    if (state === "recording") {
      stopPushRecording();
    }
    if (ambientStream) {
      stopAmbient();
    }
    mode = nextMode;
    savePresenceModePreference(mode);
    note = mode === "ambient" ? "Mind is ready" : "";
    transcriptInputNode.placeholder = mode === "ambient" ? "Ambient is on. Type here when you want to send manually." : "Type to Mind";
    setState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  }

  function setState(next: PresenceState, message?: string): void {
    state = next;
    const connected = gatewayClient.isConnected();
    const hasTranscript = transcriptInputNode.value.trim().length > 0;
    const recorderAvailable = canUseBrowserVoiceRecorder();
    const ambientAvailable = canUseAmbientMode();
    const fullStatus = message ?? statusText(next, connected, activeRuns.size);
    const compactStatus = compactPresenceStatus(next, connected, activeRuns.size);
    statusTextNode.textContent = fullStatus;
    for (const compactStatusNode of compactStatusNodes) {
      compactStatusNode.textContent = compactStatus;
    }
    panelNode.dataset.state = next;
    panelNode.dataset.agent = activeRuns.size > 0 ? "active" : "idle";
    panelNode.dataset.mode = mode;
    transcriptInputNode.placeholder = mode === "ambient"
      ? "Ambient is on. Type here when you want to send manually."
      : recorderAvailable ? "Type to Mind" : "Type a message to Mind";
    if (noteNode) {
      noteNode.textContent = note;
    }
    listenNode.textContent = listenButtonText();
    listenNode.disabled = mode === "ambient"
      ? !connected || !ambientAvailable || (!ambientStream && (next === "sending" || next === "transcribing"))
      : next === "sending" || next === "transcribing" || !connected || !recorderAvailable;
    sendNode.disabled = next === "sending" || next === "transcribing" || !connected || !hasTranscript;
    clearNode.disabled = next === "sending" || next === "transcribing" || (!hasTranscript && !note && !lastSentText);
    for (const toggle of toggles) {
      toggle.dataset.state = next;
      toggle.dataset.agent = activeRuns.size > 0 ? "active" : "idle";
      toggle.title = fullStatus;
      toggle.setAttribute("aria-label", `Mind: ${compactStatus}`);
    }
    for (const button of modeButtons) {
      const buttonMode = normalizePresenceMode(button.dataset.presenceMode);
      const selected = buttonMode === mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.disabled = (buttonMode === "ambient" && !ambientAvailable) || (next === "recording" || next === "capturing");
    }
    if (speakNode) {
      speakNode.checked = speakReplies;
      speakNode.disabled = !connected;
    }
    if (speakTestNode) {
      speakTestNode.disabled = !connected;
    }
    if (speechStatusNode && speakReplies && !localSpeechSupported()) {
      speechStatusNode.textContent = "Local speech unavailable; using gateway voice";
    }
    if (activeRuns.size === 0 && activityHideTimer === null) {
      renderIdlePresenceActivity();
    }
  }

  function listenButtonText(): string {
    if (mode === "ambient") {
      return ambientStream ? "Pause" : "Listen";
    }
    return state === "recording" ? "Stop" : "Record";
  }

  async function startPushRecording(): Promise<void> {
    if (!canUseBrowserVoiceRecorder() || !gatewayClient.isConnected()) {
      setState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    cancelSpeechOutput();
    cleanupPushRecorder();
    setPanelOpen(true);
    note = "";
    setState("recording", "Requesting microphone");
    try {
      const stream = await requestVoiceStream();
      if (destroyed) {
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
        note = "";
        setState("error", "Voice recording failed");
      };
      pushRecorder.onstop = () => {
        void finishPushRecording();
      };
      pushRecorder.start(1000);
      pushTimer = window.setInterval(() => {
        const elapsedMs = Date.now() - pushStartedAt;
        note = `Recording ${formatElapsed(elapsedMs)}`;
        setState("recording");
        if (elapsedMs >= MAX_PUSH_RECORDING_MS && pushRecorder?.state === "recording") {
          stopPushRecording();
        }
      }, 250);
      note = "Recording 0:00";
      setState("recording");
    } catch (error) {
      cleanupPushRecorder();
      note = "";
      setState("error", "Microphone failed: " + formatError(error));
    }
  }

  function stopPushRecording(): void {
    const current = pushRecorder;
    if (!current || current.state === "inactive") {
      cleanupPushRecorder();
      setState("idle");
      return;
    }
    clearPushTimer();
    note = "Transcribing";
    setState("transcribing");
    current.stop();
  }

  async function finishPushRecording(): Promise<void> {
    clearPushTimer();
    const chunks = pushChunks.slice();
    const mimeType = pushRecorder?.mimeType || chunks.find((chunk) => chunk.type)?.type || "audio/webm";
    cleanupPushRecorder();
    if (destroyed) {
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      note = "";
      setState("error", "No audio was captured");
      return;
    }

    note = "Transcribing";
    setState("transcribing");
    try {
      const result = await transcribeBlob(blob, mimeType);
      transcriptInputNode.value = appendTranscript(transcriptInputNode.value, result.text);
      note = transcriptionNote(result);
      setState("idle", "Transcribed");
    } catch (error) {
      note = "";
      setState("error", "Transcription failed: " + formatError(error));
    }
  }

  async function startAmbient(): Promise<void> {
    if (!canUseAmbientMode() || !gatewayClient.isConnected()) {
      setState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
      return;
    }
    stopAmbient();
    setPanelOpen(true);
    note = "Requesting microphone";
    setState("listening");
    try {
      const stream = await requestVoiceStream();
      if (destroyed) {
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
      note = "Mind is listening";
      setState("listening", "Listening");
    } catch (error) {
      stopAmbient();
      note = "";
      setState("error", "Microphone failed: " + formatError(error));
    }
  }

  function stopAmbient(): void {
    cancelSpeechOutput();
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
    if (state === "listening" || state === "capturing" || state === "transcribing" || state === "sending") {
      note = activeRuns.size > 0 ? ambientIdleNote() : "";
      setState("idle", activeRuns.size > 0 ? "Mind working" : "Listening paused");
    }
  }

  function tickAmbientVad(): void {
    if (!ambientAnalyser || !ambientSamples || !ambientStream) {
      return;
    }
    const now = Date.now();
    const rms = currentRms(ambientAnalyser, ambientSamples);
    const speechNow = rms >= AMBIENT_RMS_THRESHOLD;

    if (isSpeechOutputPlaying()) {
      ambientSpeechMs = 0;
      if (!ambientSpeechActive) {
        note = "Speaking";
        setState("listening");
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
      note = ambientIdleNote();
      setState(ambientPendingJobs > 0 ? "transcribing" : "listening");
      return;
    }

    const segmentMs = now - ambientSegmentStartedAt;
    const silenceMs = now - ambientLastVoiceAt;
    note = `Capturing ${formatElapsed(segmentMs)}`;
    setState("capturing");
    if (silenceMs >= AMBIENT_END_SILENCE_MS || segmentMs >= MAX_AMBIENT_SEGMENT_MS) {
      stopAmbientSegment(silenceMs >= AMBIENT_END_SILENCE_MS ? "silence" : "max");
    }
  }

  function startAmbientSegment(startedAt: number): void {
    if (!ambientStream || ambientSegmentRecorder) {
      return;
    }
    cancelSpeechOutput();
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
      note = "";
      setState("error", "Ambient recording failed");
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
      void queueAmbientSegment(chunks, mimeType, segmentStartedAt, lastVoiceAt, segmentStoppedAt);
    };
    recorder.start(250);
    note = "Capturing speech";
    setState("capturing");
  }

  function stopAmbientSegment(reason: "silence" | "max" | "stop"): void {
    const recorder = ambientSegmentRecorder;
    ambientSpeechActive = false;
    ambientSpeechMs = 0;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    if (reason === "max") {
      note = "Segment reached time limit";
    } else if (reason === "stop") {
      note = "Stopping ambient";
    } else {
      note = "Speech ended";
    }
    setState("transcribing");
    try {
      recorder.stop();
    } catch {
      ambientSegmentRecorder = null;
      ambientSegmentChunks = [];
    }
  }

  async function queueAmbientSegment(
    chunks: Blob[],
    mimeType: string,
    startedAt: number,
    lastVoiceAt: number,
    stoppedAt: number,
  ): Promise<void> {
    const durationMs = Date.now() - startedAt;
    if (durationMs < AMBIENT_MIN_SEGMENT_MS || totalBlobSize(chunks) < AMBIENT_MIN_SEGMENT_BYTES) {
      note = ambientIdleNote();
      setState("listening");
      return;
    }
    await processAmbientSegment(chunks, mimeType, startedAt, lastVoiceAt, stoppedAt);
  }

  async function processAmbientSegment(
    chunks: Blob[],
    mimeType: string,
    startedAt: number,
    lastVoiceAt: number,
    stoppedAt: number,
  ): Promise<void> {
    ambientPendingJobs += 1;
    const timing = createVoiceTimingTrace("ambient", startedAt);
    markVoiceTiming(timing, "speech_started", startedAt);
    markVoiceTiming(timing, "speech_last_voice", lastVoiceAt);
    markVoiceTiming(timing, "segment_stopped", stoppedAt);
    const blob = new Blob(chunks, { type: mimeType });
    let logRow: HTMLElement | null = null;
    note = "Transcribing speech";
    if (!ambientSpeechActive) {
      setState("transcribing");
    }
    try {
      markVoiceTiming(timing, "transcription_started");
      const result = await transcribeBlob(blob, mimeType, startedAt);
      markVoiceTiming(timing, "transcription_done");
      const text = result.text.trim();
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      timing.promptChars = text.length;
      logRow = addPresenceLog(logNode, "Sending", text, startedAt);
      note = "Sending ambient segment";
      if (!ambientSpeechActive) {
        setState("sending");
      }
      markVoiceTiming(timing, "agent_send_started");
      const sent = await sendTextToPersonalAgent(text);
      markVoiceTiming(timing, "agent_send_done");
      timing.runId = sent.runId;
      lastSentText = text;
      note = sent.queued ? "Queued for Mind" : "Mind is working";
      updatePresenceLog(logRow, sent.queued ? "Queued" : "Working");
      trackRun(sent.runId, logRow, text, sent.queued ? "Queued" : "Working", timing);
      if (transcriptInputNode.value.trim() === text) {
        transcriptInputNode.value = "";
      }
    } catch (error) {
      const message = formatError(error);
      recordVoiceTimingFailure(timing, message);
      logVoiceTimingTrace(timing, "failed");
      note = "";
      setState("error", "Ambient failed: " + message);
      if (logRow) {
        updatePresenceLog(logRow, "Failed", message);
      } else {
        addPresenceLog(logNode, "Failed", message, startedAt);
      }
    } finally {
      ambientPendingJobs = Math.max(0, ambientPendingJobs - 1);
      if (!destroyed && ambientStream && !ambientSpeechActive && state !== "error") {
        note = ambientIdleNote();
        setState(ambientPendingJobs > 0 ? "transcribing" : "listening");
      }
    }
  }

  async function transcribeBlob(blob: Blob, mimeType: string, startedAt = Date.now()): Promise<AiTranscriptionCreateResult> {
    const data = await blobToDataUrl(blob);
    const result = await gatewayClient.call<AiTranscriptionCreateResult>("ai.transcription.create", {
      audio: {
        data,
        mimeType,
        filename: presenceRecordingFilename(mimeType, startedAt),
        size: blob.size,
      },
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      throw new Error("No speech was transcribed");
    }
    return { ...result, text };
  }

  async function sendTextToPersonalAgent(message: string): Promise<PresenceSendResult> {
    const spawned = await gatewayClient.proc.spawn({
      label: "Mind",
    });
    if (!spawned.ok) {
      throw new Error(spawned.error);
    }
    const result = await gatewayClient.proc.send({
      message,
      pid: spawned.pid,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return {
      runId: result.runId,
      queued: result.queued,
    };
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

  function ambientIdleNote(): string {
    if (ambientPendingJobs > 0) {
      return `Processing ${ambientPendingJobs}`;
    }
    if (activeRuns.size > 0) {
      return activeRuns.size === 1 ? "Mind is working" : `${activeRuns.size} Mind jobs running`;
    }
    return "Mind is listening";
  }

  function trackRun(
    runId: string,
    row: HTMLElement | null,
    prompt: string,
    status: PresenceLogStatus = "Working",
    timing?: VoiceTimingTrace,
  ): void {
    if (timing) {
      timing.runId = runId;
    }
    activeRuns.set(runId, {
      row,
      prompt,
      answer: "",
      status,
      updatedAt: Date.now(),
      timing,
    });
    latestRunId = runId;
    showPresenceActivity(status, prompt);
    const replayed = replayBufferedRunSignals(runId);
    if (!replayed && activeRuns.has(runId)) {
      setState(state);
    }
  }

  function bufferRunSignal(runId: string, signal: string, payload: unknown): void {
    if (!isPresenceRunSignal(signal)) {
      return;
    }
    pruneBufferedRunSignals();
    const signals = bufferedRunSignals.get(runId) ?? [];
    signals.push({ signal, payload, receivedAt: Date.now() });
    bufferedRunSignals.set(runId, signals);
    trimBufferedRunSignals();
  }

  function replayBufferedRunSignals(runId: string): boolean {
    const signals = bufferedRunSignals.get(runId);
    if (!signals || signals.length === 0) {
      return false;
    }
    bufferedRunSignals.delete(runId);
    signals
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .forEach((entry) => handleRunSignal(entry.signal, entry.payload));
    return true;
  }

  function pruneBufferedRunSignals(): void {
    const cutoff = Date.now() - RUN_SIGNAL_BUFFER_TTL_MS;
    for (const [runId, signals] of bufferedRunSignals.entries()) {
      const fresh = signals.filter((entry) => entry.receivedAt >= cutoff);
      if (fresh.length > 0) {
        bufferedRunSignals.set(runId, fresh);
      } else {
        bufferedRunSignals.delete(runId);
      }
    }
  }

  function trimBufferedRunSignals(): void {
    let total = 0;
    for (const signals of bufferedRunSignals.values()) {
      total += signals.length;
    }
    while (total > MAX_BUFFERED_RUN_SIGNALS) {
      let oldestRunId: string | null = null;
      let oldestReceivedAt = Number.POSITIVE_INFINITY;
      for (const [runId, signals] of bufferedRunSignals.entries()) {
        const first = signals[0];
        if (first && first.receivedAt < oldestReceivedAt) {
          oldestReceivedAt = first.receivedAt;
          oldestRunId = runId;
        }
      }
      if (!oldestRunId) {
        return;
      }
      const signals = bufferedRunSignals.get(oldestRunId) ?? [];
      signals.shift();
      total -= 1;
      if (signals.length > 0) {
        bufferedRunSignals.set(oldestRunId, signals);
      } else {
        bufferedRunSignals.delete(oldestRunId);
      }
    }
  }

  function clearActivityHideTimer(): void {
    if (activityHideTimer !== null) {
      window.clearTimeout(activityHideTimer);
      activityHideTimer = null;
    }
  }

  function showPresenceActivity(status: PresenceLogStatus, body: string, tone = statusKey(status)): void {
    if (!activityNode || !activityStatusNode || !activityBodyNode) {
      return;
    }
    clearActivityHideTimer();
    activityNode.hidden = false;
    activityNode.classList.remove("is-compact");
    activityNode.dataset.status = tone;
    activityStatusNode.textContent = status;
    activityBodyNode.textContent = truncateActivityText(body.trim() || status);
    activityNode.title = `Mind: ${status}`;
    activityNode.setAttribute("aria-label", `Mind: ${status}`);
  }

  function hidePresenceActivity(): void {
    renderIdlePresenceActivity();
  }

  function renderIdlePresenceActivity(): void {
    if (!activityNode || !activityStatusNode || !activityBodyNode) {
      return;
    }
    const connected = gatewayClient.isConnected();
    const status = compactPresenceStatus(state, connected, activeRuns.size);
    const body = presenceActivityBody(state, connected);
    activityNode.hidden = false;
    activityNode.dataset.status = presenceActivityTone(state, connected);
    activityNode.classList.toggle("is-compact", shouldCompactPresenceActivity(state, connected));
    activityStatusNode.textContent = status;
    activityBodyNode.textContent = body;
    activityNode.title = `Mind: ${body}`;
    activityNode.setAttribute("aria-label", `Mind: ${status}. ${body}`);
  }

  function newestActiveRunId(): string | null {
    let nextRunId: string | null = null;
    let latestUpdatedAt = 0;
    for (const [runId, run] of activeRuns.entries()) {
      if (run.updatedAt >= latestUpdatedAt) {
        nextRunId = runId;
        latestUpdatedAt = run.updatedAt;
      }
    }
    return nextRunId;
  }

  function renderLatestActiveActivity(): void {
    const runId = latestRunId && activeRuns.has(latestRunId) ? latestRunId : newestActiveRunId();
    latestRunId = runId;
    if (!runId) {
      hidePresenceActivity();
      return;
    }
    const run = activeRuns.get(runId);
    if (run) {
      showPresenceActivity(run.status, run.answer || run.prompt);
    }
  }

  function scheduleActivityAfterCompletion(completedRunId: string): void {
    latestRunId = latestRunId === completedRunId ? newestActiveRunId() : latestRunId;
    clearActivityHideTimer();
    activityHideTimer = window.setTimeout(() => {
      activityHideTimer = null;
      renderLatestActiveActivity();
    }, activeRuns.size > 0 ? 4500 : 12000);
  }

  function presenceActivityTone(current: PresenceState, connected: boolean): string {
    if (!connected) {
      return "failed";
    }
    if (activeRuns.size > 0) {
      return "working";
    }
    switch (current) {
      case "listening": return "listening";
      case "capturing": return "capturing";
      case "recording": return "recording";
      case "transcribing": return "transcribing";
      case "sending": return "working";
      case "error": return "failed";
      case "unsupported": return "stopped";
      default: return "idle";
    }
  }

  function shouldCompactPresenceActivity(current: PresenceState, connected: boolean): boolean {
    return connected
      && !panelOpen
      && activeRuns.size === 0
      && (current === "idle" || current === "listening" || current === "unsupported");
  }

  function presenceActivityBody(current: PresenceState, connected: boolean): string {
    if (!connected) {
      return "Gateway disconnected";
    }
    if (note) {
      return note;
    }
    switch (current) {
      case "listening": return "Listening";
      case "capturing": return "Heard you";
      case "recording": return "Recording";
      case "transcribing": return "Transcribing speech";
      case "sending": return "Sending";
      case "error": return "Needs attention";
      case "unsupported": return "Voice unavailable";
      default: return mode === "ambient" ? "Click to start listening" : "Ready";
    }
  }

  function setSpeechStatus(message: string): void {
    if (speechStatusNode) {
      speechStatusNode.textContent = message;
    }
  }

  function isSpeechOutputPlaying(): boolean {
    return speechAudio !== null && !speechAudio.paused && !speechAudio.ended;
  }

  function cancelSpeechOutput(message?: string): void {
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
    if (!options?.force && !speakReplies) {
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
    if (options?.interrupt === false && isSpeechOutputPlaying()) {
      return;
    }
    if (options?.interrupt !== false) {
      cancelSpeechOutput();
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
        setSpeechStatus(speakReplies ? "Speak replies on" : "Speech off");
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
    if (!speakReplies || !run.answer.trim()) {
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
    if (destroyed || !speakReplies) {
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
        setSpeechStatus(speakReplies ? "Speak replies on" : "Speech off");
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

  function scheduleInterimSpeech(runId: string, text: string, key: string): void {
    if (!speakReplies) {
      return;
    }
    const normalized = normalizeInterimSpeechText(text);
    if (!normalized) {
      return;
    }
    clearPendingInterimSpeech(runId);
    const timer = window.setTimeout(() => {
      pendingInterimSpeech.delete(runId);
      speakInterimStatus(normalized, key);
    }, INTERIM_SPEECH_DELAY_MS);
    pendingInterimSpeech.set(runId, { timer, text: normalized, key });
  }

  function clearPendingInterimSpeech(runId?: string): void {
    if (runId) {
      const pending = pendingInterimSpeech.get(runId);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingInterimSpeech.delete(runId);
      }
      return;
    }
    for (const pending of pendingInterimSpeech.values()) {
      window.clearTimeout(pending.timer);
    }
    pendingInterimSpeech.clear();
  }

  function hasPendingInterimSpeech(runId: string): boolean {
    return pendingInterimSpeech.has(runId);
  }

  function speakInterimStatus(text: string, key: string): void {
    if (!speakReplies || !gatewayClient.isConnected()) {
      return;
    }
    const now = Date.now();
    if (key === lastInterimSpeechKey && now - lastInterimSpeechAt < INTERIM_SPEECH_COOLDOWN_MS) {
      return;
    }
    lastInterimSpeechKey = key;
    lastInterimSpeechAt = now;
    void speakReply(text, { interrupt: false });
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
    markVoiceTiming(timing, chunk.index === 0 ? "tts_first_chunk_requested" : "tts_chunk_requested");
    if (localSpeechSupported()) {
      try {
        const audio = await synthesizeLocalSpeech(chunk.text, {
          onProgress(progress) {
            if (attempt === speechAttempt) {
              setSpeechStatus(progress.message);
            }
          },
        });
        const result: AiSpeechCreateResult = {
          audio: {
            data: URL.createObjectURL(audio),
            mimeType: audio.type || "audio/wav",
            size: audio.size,
          },
          provider: "local-piper",
          model: "piper",
        };
        recordVoiceTimingChunkReady(timing, chunk, requestedAt, result);
        return result;
      } catch (error) {
        if (attempt !== speechAttempt) {
          throw error;
        }
        markVoiceTiming(timing, "tts_local_fallback");
        setSpeechStatus(`Local speech failed: ${formatError(error)}. Trying gateway voice.`);
      }
    }

    const result = await gatewayClient.call<AiSpeechCreateResult>("ai.speech.create", {
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

  function speechChunkStatus(prefix: string, chunk: SpeechChunk): string {
    return chunk.total > 1 ? `${prefix} ${chunk.index + 1}/${chunk.total}` : prefix;
  }

  function handleRunSignal(signal: string, payload: unknown): void {
    const runId = runIdFromSignalPayload(payload);
    if (!runId) {
      return;
    }
    const run = activeRuns.get(runId);
    if (!run) {
      bufferRunSignal(runId, signal, payload);
      return;
    }
    markRunActivity(run, signal);

    if (signal === "proc.run.retrying") {
      run.status = "Working";
      run.updatedAt = Date.now();
      latestRunId = runId;
      updatePresenceLog(run.row, "Working");
      note = "Mind is retrying";
      showPresenceActivity("Working", run.answer || run.prompt);
      setState(state);
      return;
    }

    if (signal === "proc.run.stream") {
      const delta = signalPayloadStreamTextDelta(payload);
      if (delta) {
        markVoiceTimingOnce(run.timing, "agent_first_text");
        run.status = "Responding";
        run.updatedAt = Date.now();
        run.answer = `${run.answer}${delta}`;
        latestRunId = runId;
        updatePresenceLog(run.row, "Responding");
        note = "Mind is responding";
        showPresenceActivity("Responding", run.answer || run.prompt);
        clearPendingInterimSpeech(runId);
        queueRunSpeechFromAnswer(run, false);
        setState(state);
        return;
      }

      const toolLabel = signalPayloadStreamToolLabel(payload);
      if (toolLabel) {
        markVoiceTimingOnce(run.timing, "agent_first_tool_call");
        run.status = "Using tools";
        run.updatedAt = Date.now();
        latestRunId = runId;
        updatePresenceLog(run.row, "Using tools");
        note = `Mind is using ${toolLabel}`;
        showPresenceActivity("Using tools", `Using ${toolLabel}`);
        if (!hasPendingInterimSpeech(runId)) {
          speakInterimStatus(`Using ${toolLabel}.`, `tool:${runId}:${toolLabel}`);
        }
        setState(state);
        return;
      }

      return;
    }

    if (signal === "chat.text") {
      markVoiceTiming(run.timing, "agent_first_text");
      run.status = "Responding";
      run.updatedAt = Date.now();
      run.answer = signalPayloadText(payload) ?? run.answer;
      latestRunId = runId;
      updatePresenceLog(run.row, "Responding");
      note = "Mind is responding";
      showPresenceActivity("Responding", run.answer || run.prompt);
      if (run.answer) {
        scheduleInterimSpeech(runId, run.answer, `text:${runId}:${run.answer}`);
      }
      setState(state);
      return;
    }

    if (signal === "proc.run.output") {
      markVoiceTimingOnce(run.timing, "agent_first_text");
      run.status = "Responding";
      run.updatedAt = Date.now();
      run.answer = signalPayloadText(payload) ?? run.answer;
      latestRunId = runId;
      updatePresenceLog(run.row, "Responding");
      note = "Mind is responding";
      showPresenceActivity("Responding", run.answer || run.prompt);
      setState(state);
      return;
    }

    if (signal === "chat.tool_call" || signal === "proc.run.tool.started") {
      const toolLabel = signalPayloadToolLabel(payload);
      markVoiceTiming(run.timing, "agent_first_tool_call");
      run.status = "Using tools";
      run.updatedAt = Date.now();
      latestRunId = runId;
      updatePresenceLog(run.row, "Using tools");
      note = toolLabel ? `Mind is using ${toolLabel}` : "Mind is using tools";
      showPresenceActivity("Using tools", toolLabel ? `Using ${toolLabel}` : run.answer || run.prompt);
      if (!hasPendingInterimSpeech(runId)) {
        speakInterimStatus(toolLabel ? `Using ${toolLabel}.` : "Using tools.", `tool:${runId}:${toolLabel ?? ""}`);
      }
      setState(state);
      return;
    }

    if (signal === "chat.tool_result" || signal === "proc.run.tool.finished") {
      run.status = "Working";
      run.updatedAt = Date.now();
      latestRunId = runId;
      updatePresenceLog(run.row, "Working");
      note = "Mind is working";
      showPresenceActivity("Working", run.answer || run.prompt);
      setState(state);
      return;
    }

    if (signal === "chat.hil" || signal === "proc.run.hil.requested") {
      markVoiceTiming(run.timing, "agent_needs_approval");
      run.status = "Needs approval";
      run.updatedAt = Date.now();
      latestRunId = runId;
      updatePresenceLog(run.row, "Needs approval");
      note = "Mind needs approval";
      showPresenceActivity("Needs approval", run.answer || run.prompt, "needs-approval");
      clearPendingInterimSpeech(runId);
      speakInterimStatus("I need approval to continue.", `hil:${runId}`);
      setState(state);
      return;
    }

    if (signal === "chat.complete" || signal === "proc.run.finished") {
      const error = signalPayloadError(payload);
      const aborted = signalPayloadAborted(payload);
      run.answer = signalPayloadText(payload) ?? run.answer;
      markVoiceTiming(run.timing, "agent_complete");
      if (run.timing) {
        run.timing.answerChars = run.answer.length;
      }
      clearPendingInterimSpeech(runId);
      const finalStatus = error ? "Failed" : aborted ? "Stopped" : "Done";
      updatePresenceLog(run.row, finalStatus, error ?? undefined);
      activeRuns.delete(runId);
      note = error
        ? `Mind failed: ${error}`
        : aborted ? "Mind stopped" : activeRuns.size > 0 ? ambientIdleNote() : "Mind finished";
      showPresenceActivity(
        finalStatus,
        error ?? (run.answer || run.prompt),
        finalStatus === "Failed" ? "failed" : finalStatus === "Stopped" ? "stopped" : "done",
      );
      if (!error && !aborted && run.answer) {
        if (!finalizeRunSpeech(run)) {
          void speakReply(run.answer, { timing: run.timing });
        }
      } else if (run.timing) {
        logVoiceTimingTrace(run.timing, finalStatus.toLowerCase());
      }
      scheduleActivityAfterCompletion(runId);
      setState(error ? "error" : state);
    }
  }

  async function sendManualTextToPersonalAgent(): Promise<void> {
    const message = transcriptInputNode.value.trim();
    if (!message || !gatewayClient.isConnected()) {
      return;
    }
    if (state === "recording") {
      stopPushRecording();
      return;
    }
    setState("sending", "Sending to Mind");
    const logRow = addPresenceLog(logNode, "Sending", message, Date.now());
    const timing = createVoiceTimingTrace("manual");
    timing.promptChars = message.length;
    try {
      markVoiceTiming(timing, "agent_send_started");
      const sent = await sendTextToPersonalAgent(message);
      markVoiceTiming(timing, "agent_send_done");
      timing.runId = sent.runId;
      lastSentText = message;
      transcriptInputNode.value = "";
      note = sent.queued ? "Queued for Mind" : "Mind is working";
      updatePresenceLog(logRow, sent.queued ? "Queued" : "Working");
      trackRun(sent.runId, logRow, message, sent.queued ? "Queued" : "Working", timing);
      if (activeRuns.has(sent.runId)) {
        setState(ambientStream ? "listening" : "idle", note);
      }
    } catch (error) {
      const errorMessage = formatError(error);
      recordVoiceTimingFailure(timing, errorMessage);
      logVoiceTimingTrace(timing, "failed");
      updatePresenceLog(logRow, "Failed", errorMessage);
      setState("error", errorMessage);
    }
  }

  const listeners: Array<() => void> = [];
  for (const toggle of toggles) {
    const onClick = () => {
      setPanelOpen(!panelOpen);
      if (!panelOpen) {
        return;
      }
      setState(state);
    };
    toggle.addEventListener("click", onClick);
    listeners.push(() => toggle.removeEventListener("click", onClick));
  }

  for (const button of modeButtons) {
    const onClick = () => {
      const nextMode = normalizePresenceMode(button.dataset.presenceMode);
      if (nextMode) {
        setMode(nextMode);
      }
    };
    button.addEventListener("click", onClick);
    listeners.push(() => button.removeEventListener("click", onClick));
  }

  const onClose = () => {
    if (state === "recording") {
      stopPushRecording();
    }
    setPanelOpen(false);
  };
  const onListen = () => {
    if (mode === "ambient") {
      if (ambientStream) {
        stopAmbient();
        return;
      }
      void startAmbient();
      return;
    }
    if (state === "recording") {
      stopPushRecording();
      return;
    }
    void startPushRecording();
  };
  const onSend = () => void sendManualTextToPersonalAgent();
  const onClear = () => {
    transcriptInputNode.value = "";
    note = ambientStream
      ? ambientIdleNote()
      : activeRuns.size > 0 ? "Mind is working" : mode === "ambient" ? "Mind is ready" : "";
    lastSentText = "";
    setState(ambientStream ? "listening" : canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  };
  const onActivityClick = () => {
    const nextOpen = !panelOpen;
    setPanelOpen(nextOpen);
    if (nextOpen) {
      setState(state);
    }
  };
  const onSpeakToggle = () => {
    speakReplies = speakNode?.checked === true;
    saveSpeakRepliesPreference(speakReplies);
    if (!speakReplies) {
      cancelSpeechOutput("Speech off");
    } else {
      void speakReply("Mind voice is on.", { force: true });
    }
    setState(state);
  };
  const onSpeakTest = () => {
    void speakReply("This is Mind.", { force: true });
  };
  const onTranscriptInput = () => setState(state);

  closeButton?.addEventListener("click", onClose);
  listenNode.addEventListener("click", onListen);
  sendNode.addEventListener("click", onSend);
  clearNode.addEventListener("click", onClear);
  activityNode?.addEventListener("click", onActivityClick);
  speakNode?.addEventListener("change", onSpeakToggle);
  speakTestNode?.addEventListener("click", onSpeakTest);
  transcriptInputNode.addEventListener("input", onTranscriptInput);
  listeners.push(
    () => closeButton?.removeEventListener("click", onClose),
    () => listenNode.removeEventListener("click", onListen),
    () => sendNode.removeEventListener("click", onSend),
    () => clearNode.removeEventListener("click", onClear),
    () => activityNode?.removeEventListener("click", onActivityClick),
    () => speakNode?.removeEventListener("change", onSpeakToggle),
    () => speakTestNode?.removeEventListener("click", onSpeakTest),
    () => transcriptInputNode.removeEventListener("input", onTranscriptInput),
    gatewayClient.onSignal(handleRunSignal),
    gatewayClient.onStatus((status) => {
      if (status.state !== "connected") {
        cleanupPushRecorder();
        cancelSpeechOutput("Speech unavailable while disconnected");
        stopAmbient();
        setState(state === "unsupported" ? "unsupported" : "idle");
        return;
      }
      setState(canUseBrowserVoiceRecorder() ? state === "unsupported" ? "idle" : state : "unsupported");
    }),
  );

  note = mode === "ambient" ? "Mind is ready" : "";
  setState(state);
  setSpeechStatus(
    speakReplies
      ? localSpeechSupported() ? "Speak replies on" : "Local speech unavailable; using gateway voice"
      : "Speech off",
  );

  return {
    destroy() {
      destroyed = true;
      clearActivityHideTimer();
      clearPendingInterimSpeech();
      cancelSpeechOutput();
      cleanupPushRecorder();
      stopAmbient();
      for (const remove of listeners) {
        remove();
      }
    },
  };
}

function loadPresenceModePreference(): PresenceMode {
  try {
    const mode = normalizePresenceMode(window.localStorage.getItem(PRESENCE_MODE_STORAGE_KEY));
    if (mode === "ambient" && !canUseAmbientMode()) {
      return "push";
    }
    return mode ?? defaultPresenceMode();
  } catch {
    return defaultPresenceMode();
  }
}

function savePresenceModePreference(mode: PresenceMode): void {
  try {
    window.localStorage.setItem(PRESENCE_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore unavailable storage; the in-memory state still applies for this session.
  }
}

function defaultPresenceMode(): PresenceMode {
  return canUseAmbientMode() ? "ambient" : "push";
}

function loadSpeakRepliesPreference(): boolean {
  try {
    return window.localStorage.getItem(SPEAK_REPLIES_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveSpeakRepliesPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SPEAK_REPLIES_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore unavailable storage; the in-memory state still applies for this session.
  }
}

function canUseBrowserVoiceRecorder(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
}

function canUseAmbientMode(): boolean {
  return canUseBrowserVoiceRecorder() && Boolean(resolveAudioContext());
}

async function requestVoiceStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}

function resolveAudioContext(): typeof AudioContext | null {
  const audioWindow = window as AudioWindow;
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function createAudioContext(): AudioContext {
  const AudioContextConstructor = resolveAudioContext();
  if (!AudioContextConstructor) {
    throw new Error("Audio analysis is unavailable in this browser");
  }
  return new AudioContextConstructor();
}

function selectVoiceRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return PRESENCE_RECORDER_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function extensionForVoiceMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/mp4" || normalized === "audio/aac") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  return "webm";
}

function presenceRecordingFilename(mimeType: string, timestamp = Date.now()): string {
  const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `presence-${stamp}.${extensionForVoiceMimeType(mimeType)}`;
}

function appendTranscript(current: string, addition: string): string {
  return `${current.trim()} ${addition.trim()}`.trim();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read audio"));
    };
    reader.readAsDataURL(blob);
  });
}

function currentRms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length);
}

function totalBlobSize(blobs: Blob[]): number {
  return blobs.reduce((sum, blob) => sum + blob.size, 0);
}

function normalizePresenceMode(value: unknown): PresenceMode | null {
  return value === "ambient" || value === "push" ? value : null;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function transcriptionNote(result: AiTranscriptionCreateResult): string {
  const parts: string[] = [];
  if (typeof result.language === "string" && result.language.trim()) {
    parts.push(result.language.trim());
  }
  if (typeof result.duration === "number" && Number.isFinite(result.duration) && result.duration > 0) {
    parts.push(`${Math.round(result.duration)}s`);
  }
  return parts.length > 0 ? `Transcribed ${parts.join(" / ")}` : "";
}

function addPresenceLog(
  log: HTMLElement | null,
  status: PresenceLogStatus,
  text: string,
  timestamp: number,
): HTMLElement | null {
  if (!log) {
    return null;
  }
  log.hidden = false;
  const row = document.createElement("div");
  row.className = "presence-log-row";
  row.dataset.timestamp = String(timestamp);
  const meta = document.createElement("span");
  meta.className = "presence-log-meta";
  const body = document.createElement("p");
  body.textContent = text;
  row.append(meta, body);
  updatePresenceLog(row, status);
  log.prepend(row);
  while (log.children.length > 6) {
    log.lastElementChild?.remove();
  }
  return row;
}

function updatePresenceLog(row: HTMLElement | null, status: PresenceLogStatus, text?: string): void {
  if (!row) {
    return;
  }
  const timestamp = Number(row.dataset.timestamp) || Date.now();
  row.dataset.status = statusKey(status);
  const meta = row.querySelector<HTMLElement>(".presence-log-meta");
  if (meta) {
    meta.textContent = `${formatClock(timestamp)} ${status}`;
  }
  if (typeof text === "string") {
    const body = row.querySelector<HTMLParagraphElement>("p");
    if (body) {
      body.textContent = text;
    }
  }
}

function runIdFromSignalPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.runId === "string" && payload.runId.length > 0 ? payload.runId : null;
}

function isPresenceRunSignal(signal: string): boolean {
  return signal === "chat.text"
    || signal === "chat.tool_call"
    || signal === "chat.tool_result"
    || signal === "chat.hil"
    || signal === "chat.complete"
    || signal === "proc.run.stream"
    || signal === "proc.run.retrying"
    || signal === "proc.run.output"
    || signal === "proc.run.tool.started"
    || signal === "proc.run.tool.finished"
    || signal === "proc.run.hil.requested"
    || signal === "proc.run.finished";
}

function signalPayloadError(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.error !== "string") {
    return null;
  }
  const error = payload.error.trim();
  return error.length > 0 ? error : null;
}

function signalPayloadAborted(payload: unknown): boolean {
  return isRecord(payload) && payload.aborted === true;
}

function signalPayloadText(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.text !== "string") {
    return null;
  }
  const text = payload.text.trim();
  return text.length > 0 ? text : null;
}

function signalPayloadToolLabel(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const syscall = typeof payload.syscall === "string" ? payload.syscall.trim() : "";
  const label = name || syscall;
  return label.length > 0 ? label : null;
}

function signalPayloadStreamTextDelta(payload: unknown): string | null {
  const event = signalPayloadStreamEvent(payload);
  if (!event || event.type !== "text_delta" || typeof event.delta !== "string") {
    return null;
  }
  return event.delta.length > 0 ? event.delta : null;
}

function signalPayloadStreamToolLabel(payload: unknown): string | null {
  const event = signalPayloadStreamEvent(payload);
  if (!event) {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "toolcall_start" && type !== "toolcall_delta" && type !== "toolcall_end") {
    return null;
  }
  const toolCall = isRecord(event.toolCall) ? event.toolCall : streamToolCallBlock(event);
  if (!toolCall) {
    return null;
  }
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  const syscall = typeof toolCall.syscall === "string" ? toolCall.syscall.trim() : "";
  const label = name || syscall;
  return label.length > 0 ? label : null;
}

function signalPayloadStreamEvent(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.event)) {
    return null;
  }
  return payload.event;
}

function streamToolCallBlock(event: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof event.contentIndex !== "number") {
    return null;
  }
  const partial = isRecord(event.partial) ? event.partial : null;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const block = content[event.contentIndex];
  return isRecord(block) && block.type === "toolCall" ? block : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function statusKey(status: PresenceLogStatus): string {
  return status.toLowerCase().replace(/\s+/g, "-");
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createVoiceTimingTrace(source: VoiceTimingTrace["source"], createdAt = Date.now()): VoiceTimingTrace {
  return {
    id: createTimingId(),
    source,
    createdAt,
    marks: {},
    chunks: [],
  };
}

function markVoiceTiming(timing: VoiceTimingTrace | undefined, mark: string, at = Date.now()): void {
  if (!timing) {
    return;
  }
  timing.marks[mark] = at;
}

function markVoiceTimingOnce(timing: VoiceTimingTrace | undefined, mark: string, at = Date.now()): void {
  if (!timing || timing.marks[mark] !== undefined) {
    return;
  }
  timing.marks[mark] = at;
}

function recordVoiceTimingFailure(
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

function markRunActivity(run: PresenceRun, signal: string): void {
  markVoiceTimingOnce(run.timing, "agent_first_activity");
  markVoiceTimingOnce(run.timing, `agent_first_${signal.replace(/\W+/g, "_")}`);
}

function recordVoiceTimingChunkReady(
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
    markVoiceTiming(timing, "tts_first_audio_ready", entry.audioReadyAt);
  }
}

function recordVoiceTimingChunkPlaybackStart(timing: VoiceTimingTrace | undefined, chunk: SpeechChunk): void {
  if (!timing) {
    return;
  }
  const now = Date.now();
  const entry = ensureVoiceTimingChunk(timing, chunk, now);
  entry.playbackStartedAt = now;
  if (chunk.index === 0) {
    markVoiceTiming(timing, "tts_first_audio_playing", now);
  }
  if (typeof timing.lastChunkEndedAt === "number") {
    entry.gapMs = Math.max(0, now - timing.lastChunkEndedAt);
  }
}

function recordVoiceTimingChunkPlaybackEnd(timing: VoiceTimingTrace | undefined, chunk: SpeechChunk): void {
  if (!timing) {
    return;
  }
  const now = Date.now();
  const entry = ensureVoiceTimingChunk(timing, chunk, now);
  entry.playbackEndedAt = now;
  timing.lastChunkEndedAt = now;
  if (chunk.index === chunk.total - 1) {
    markVoiceTiming(timing, "tts_done", now);
  }
}

function logVoiceTimingTrace(timing: VoiceTimingTrace | undefined, reason: string): void {
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
    replyToFirstAudioReadyMs: durationMs(marks.agent_complete, marks.tts_first_audio_ready),
    replyToFirstAudioPlayingMs: durationMs(marks.agent_complete, marks.tts_first_audio_playing),
    firstChunkSynthesisMs: durationMs(marks.tts_first_chunk_requested, marks.tts_first_audio_ready),
    speechPlaybackMs: durationMs(marks.tts_first_audio_playing, marks.tts_done),
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

function normalizeInterimSpeechText(text: string): string {
  if (text.includes("```") || text.includes("\n|")) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > INTERIM_SPEECH_MAX_CHARS) {
    return "";
  }
  return /[.!?:;)]$/.test(normalized) ? normalized : `${normalized}.`;
}

function selectSpeechPrefix(
  pending: string,
  final: boolean,
  firstChunk: boolean,
): { text: string; consumed: number } | null {
  const leading = pending.match(/^\s*/)?.[0].length ?? 0;
  const body = pending.slice(leading);
  if (!body.trim()) {
    return null;
  }

  const minChars = SPEECH_FIRST_CHUNK_MIN_CHARS;
  const maxChars = firstChunk ? SPEECH_FIRST_CHUNK_MAX_CHARS : SPEECH_CHUNK_MAX_CHARS;
  const sentenceEnd = sentenceEndAfter(body, minChars);
  let end = sentenceEnd;

  if (end === null || end > maxChars) {
    if (!final && body.length < maxChars) {
      return null;
    }
    end = wordBoundaryAt(body, maxChars);
  }

  if (final && body.length <= maxChars && (sentenceEnd === null || sentenceEnd > body.length)) {
    end = body.length;
  }

  const text = body.slice(0, end).trim();
  return text ? { text, consumed: leading + end } : null;
}

function sentenceEndAfter(text: string, minChars: number): number | null {
  const matcher = /[.!?](?:["')\]]+)?(?:\s+|$)/g;
  for (;;) {
    const match = matcher.exec(text);
    if (!match) {
      return null;
    }
    const end = match.index + match[0].length;
    if (end >= minChars) {
      return end;
    }
  }
}

function wordBoundaryAt(text: string, maxChars: number): number {
  if (text.length <= maxChars) {
    return text.length;
  }
  for (let index = Math.min(maxChars, text.length - 1); index > 0; index -= 1) {
    if (/\s/.test(text[index])) {
      return index;
    }
  }
  return Math.min(maxChars, text.length);
}

function chunkSpeechText(text: string): SpeechChunk[] {
  const chunks: string[] = [];

  for (const block of speechBlocks(text)) {
    if (isMarkdownStructuralBlock(block)) {
      flushSpeechChunk(chunks, block);
      continue;
    }
    for (const sentence of splitSpeechSentences(block)) {
      const maxChars = chunks.length === 0 ? SPEECH_FIRST_CHUNK_MAX_CHARS : SPEECH_CHUNK_MAX_CHARS;
      for (const part of splitLongSpeechPart(sentence, maxChars)) {
        flushSpeechChunk(chunks, part);
      }
    }
  }

  const balanced = balanceSpeechChunks(chunks);
  return balanced.map((chunk, index) => ({
    text: chunk,
    index,
    total: balanced.length,
  }));
}

function balanceSpeechChunks(chunks: string[]): string[] {
  if (chunks.length <= 1 || chunks[0].length >= SPEECH_FIRST_CHUNK_MIN_CHARS) {
    return chunks;
  }

  const balanced = chunks.slice();
  while (balanced.length > 1 && balanced[0].length < SPEECH_FIRST_CHUNK_MIN_CHARS) {
    const merged = `${balanced[0]} ${balanced[1]}`.trim();
    if (merged.length <= SPEECH_FIRST_CHUNK_TARGET_CHARS) {
      balanced.splice(0, 2, merged);
      continue;
    }

    const availableChars = SPEECH_FIRST_CHUNK_TARGET_CHARS - balanced[0].length - 1;
    const [head, tail] = splitSpeechPrefix(balanced[1], availableChars);
    if (!head) {
      break;
    }
    balanced[0] = `${balanced[0]} ${head}`.trim();
    if (tail) {
      balanced[1] = tail;
    } else {
      balanced.splice(1, 1);
    }
    break;
  }
  return balanced;
}

function splitSpeechPrefix(text: string, maxChars: number): [string, string] {
  if (maxChars <= 0 || text.length <= maxChars) {
    return [text.trim(), ""];
  }

  const words = text.split(/\s+/).filter(Boolean);
  let consumed = 0;
  let prefix = "";
  for (const word of words) {
    const next = prefix ? `${prefix} ${word}` : word;
    if (next.length > maxChars) {
      break;
    }
    prefix = next;
    consumed += 1;
  }
  return [prefix, words.slice(consumed).join(" ")];
}

function speechBlocks(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => splitSpeechMarkdownBlock(block))
    .map((line) => punctuateSpeechLine(line.trim()))
    .filter(Boolean);
}

function splitSpeechMarkdownBlock(block: string): string[] {
  const trimmed = block.trim();
  if (!trimmed) {
    return [];
  }
  if (isMarkdownStructuralBlock(trimmed)) {
    return [trimmed];
  }
  return trimmed.split(/\n+/);
}

function isMarkdownStructuralBlock(block: string): boolean {
  const lines = block.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const first = lines[0];
  if (first.startsWith("```") || first.startsWith("~~~")) {
    return true;
  }
  return lines.length >= 2 && lines.every((line) => line.startsWith("|"));
}

function punctuateSpeechLine(line: string): string {
  if (!line) {
    return "";
  }
  if (isMarkdownStructuralBlock(line)) {
    return line;
  }
  const cleaned = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  if (!cleaned) {
    return "";
  }
  return /[.!?:;)]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function splitSpeechSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [text])
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitLongSpeechPart(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) {
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    flushSpeechChunk(chunks, current);
    current = word;
  }
  flushSpeechChunk(chunks, current);
  return chunks;
}

function flushSpeechChunk(chunks: string[], value: string): void {
  const normalized = value.trim();
  if (normalized) {
    chunks.push(normalized);
  }
}

function truncateActivityText(text: string): string {
  return text.length > 420 ? `${text.slice(0, 419).trimEnd()}...` : text;
}

function statusText(state: PresenceState, connected: boolean, activeRuns = 0): string {
  if (!connected) {
    return "Disconnected";
  }
  if (activeRuns > 0 && (state === "idle" || state === "listening")) {
    return activeRuns === 1 ? "Mind working" : `${activeRuns} Mind jobs`;
  }
  switch (state) {
    case "listening": return "Listening";
    case "capturing": return "Capturing speech";
    case "recording": return "Recording";
    case "transcribing": return "Transcribing";
    case "sending": return "Sending";
    case "unsupported": return "Mind unavailable; type instead";
    case "error": return "Needs attention";
    default: return "Paused";
  }
}

function compactPresenceStatus(state: PresenceState, connected: boolean, activeRuns = 0): string {
  if (!connected) {
    return "Offline";
  }
  if (activeRuns > 0) {
    return activeRuns === 1 ? "Working" : `${activeRuns} jobs`;
  }
  switch (state) {
    case "listening": return "Listening";
    case "capturing": return "Heard";
    case "recording": return "Recording";
    case "transcribing": return "Transcribing";
    case "sending": return "Sending";
    case "unsupported": return "Text only";
    case "error": return "Attention";
    default: return "Paused";
  }
}
