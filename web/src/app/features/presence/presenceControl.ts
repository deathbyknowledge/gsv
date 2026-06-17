import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import type { GSVClient } from "@humansandmachines/gsv/client";
import {
  blobToDataUrl,
  canUseAmbientMode,
  canUseBrowserVoiceRecorder,
  presenceRecordingFilename,
  totalBlobSize,
} from "./audio";
import {
  AMBIENT_MIN_SEGMENT_BYTES,
  AMBIENT_MIN_SEGMENT_MS,
  INTERIM_SPEECH_COOLDOWN_MS,
  INTERIM_SPEECH_DELAY_MS,
  MAX_BUFFERED_RUN_SIGNALS,
  RUN_SIGNAL_BUFFER_TTL_MS,
} from "./constants";
import {
  addPresenceLog,
  appendTranscript,
  compactPresenceStatus,
  formatError,
  statusKey,
  statusText,
  transcriptionNote,
  truncateActivityText,
  updatePresenceLog,
} from "./display";
import {
  loadPresenceModePreference,
  loadSpeakRepliesPreference,
  normalizePresenceMode,
  savePresenceModePreference,
  saveSpeakRepliesPreference,
} from "./preferences";
import { createPresenceRecorder, type AmbientSegment } from "./recording";
import {
  isPresenceRunSignal,
  runIdFromSignalPayload,
  signalPayloadAborted,
  signalPayloadError,
  signalPayloadStreamTextDelta,
  signalPayloadStreamToolLabel,
  signalPayloadText,
  signalPayloadToolLabel,
} from "./signals";
import { createPresenceSpeechOutput } from "./speechOutput";
import { normalizeInterimSpeechText } from "./speechText";
import type {
  BufferedRunSignal,
  PendingInterimSpeech,
  PresenceLogStatus,
  PresenceMode,
  PresenceRun,
  PresenceSendResult,
  PresenceState,
  VoiceTimingTrace,
} from "./types";
import {
  createVoiceTimingTrace,
  logVoiceTimingTrace,
  markRunActivity,
  markVoiceTiming,
  markVoiceTimingOnce,
  recordVoiceTimingFailure,
} from "./voiceTiming";

type PresenceGsvClient = Pick<GSVClient, "ai" | "isConnected" | "onSignal" | "onStatus" | "proc">;

type PresenceOptions = {
  rootNode: HTMLElement;
  gatewayClient: PresenceGsvClient;
};

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
  let lastInterimSpeechKey = "";
  let lastInterimSpeechAt = 0;
  const activeRuns = new Map<string, PresenceRun>();
  const bufferedRunSignals = new Map<string, BufferedRunSignal[]>();
  const pendingInterimSpeech = new Map<string, PendingInterimSpeech>();
  let ambientPendingJobs = 0;
  const speechOutput = createPresenceSpeechOutput({
    gatewayClient,
    getSpeakReplies: () => speakReplies,
    isDestroyed: () => destroyed,
    setSpeechStatus,
  });
  const recorder = createPresenceRecorder({
    isConnected: () => gatewayClient.isConnected(),
    isDestroyed: () => destroyed,
    isSpeechOutputPlaying: () => speechOutput.isPlaying(),
    cancelSpeechOutput: () => speechOutput.cancel(),
    activeRunCount: () => activeRuns.size,
    hasAmbientPendingJobs: () => ambientPendingJobs > 0,
    ambientIdleNote,
    setPanelOpen,
    setNote: (nextNote) => {
      note = nextNote;
    },
    getState: () => state,
    setState,
    transcribe: transcribeBlob,
    onPushTranscribed: (result) => {
      transcriptInputNode.value = appendTranscript(transcriptInputNode.value, result.text);
      note = transcriptionNote(result);
      setState("idle", "Transcribed");
    },
    onAmbientSegment: queueAmbientSegment,
  });

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
      recorder.stopPushRecording();
    }
    if (recorder.isAmbientActive()) {
      recorder.stopAmbient();
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
      ? !connected || !ambientAvailable || (!recorder.isAmbientActive() && (next === "sending" || next === "transcribing"))
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
    if (activeRuns.size === 0 && activityHideTimer === null) {
      renderIdlePresenceActivity();
    }
  }

  function listenButtonText(): string {
    if (mode === "ambient") {
      return recorder.isAmbientActive() ? "Pause" : "Listen";
    }
    return state === "recording" ? "Stop" : "Record";
  }

  async function queueAmbientSegment(segment: AmbientSegment): Promise<void> {
    const durationMs = Date.now() - segment.startedAt;
    if (durationMs < AMBIENT_MIN_SEGMENT_MS || totalBlobSize(segment.chunks) < AMBIENT_MIN_SEGMENT_BYTES) {
      note = ambientIdleNote();
      setState("listening");
      return;
    }
    await processAmbientSegment(segment);
  }

  async function processAmbientSegment(segment: AmbientSegment): Promise<void> {
    ambientPendingJobs += 1;
    const timing = createVoiceTimingTrace("ambient", segment.startedAt);
    markVoiceTiming(timing, "speech_started", segment.startedAt);
    markVoiceTiming(timing, "speech_last_voice", segment.lastVoiceAt);
    markVoiceTiming(timing, "segment_stopped", segment.stoppedAt);
    const blob = new Blob(segment.chunks, { type: segment.mimeType });
    let logRow: HTMLElement | null = null;
    note = "Transcribing speech";
    if (!recorder.isAmbientCapturing()) {
      setState("transcribing");
    }
    try {
      markVoiceTiming(timing, "transcription_started");
      const result = await transcribeBlob(blob, segment.mimeType, segment.startedAt);
      markVoiceTiming(timing, "transcription_done");
      const text = result.text.trim();
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      timing.promptChars = text.length;
      logRow = addPresenceLog(logNode, "Sending", text, segment.startedAt);
      note = "Sending ambient segment";
      if (!recorder.isAmbientCapturing()) {
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
        addPresenceLog(logNode, "Failed", message, segment.startedAt);
      }
    } finally {
      ambientPendingJobs = Math.max(0, ambientPendingJobs - 1);
      if (!destroyed && recorder.isAmbientActive() && !recorder.isAmbientCapturing() && state !== "error") {
        note = ambientIdleNote();
        setState(ambientPendingJobs > 0 ? "transcribing" : "listening");
      }
    }
  }

  async function transcribeBlob(blob: Blob, mimeType: string, startedAt = Date.now()): Promise<AiTranscriptionCreateResult> {
    const data = await blobToDataUrl(blob);
    const result = await gatewayClient.ai.transcription.create({
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
    void speechOutput.speakReply(text, { interrupt: false });
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
        speechOutput.queueRunSpeechFromAnswer(run, false);
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
        if (!speechOutput.finalizeRunSpeech(run)) {
          void speechOutput.speakReply(run.answer, { timing: run.timing });
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
      recorder.stopPushRecording();
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
        setState(recorder.isAmbientActive() ? "listening" : "idle", note);
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
      recorder.stopPushRecording();
    }
    setPanelOpen(false);
  };
  const onListen = () => {
    if (mode === "ambient") {
      if (recorder.isAmbientActive()) {
        recorder.stopAmbient();
        return;
      }
      void recorder.startAmbient();
      return;
    }
    if (state === "recording") {
      recorder.stopPushRecording();
      return;
    }
    void recorder.startPushRecording();
  };
  const onSend = () => void sendManualTextToPersonalAgent();
  const onClear = () => {
    transcriptInputNode.value = "";
    note = recorder.isAmbientActive()
      ? ambientIdleNote()
      : activeRuns.size > 0 ? "Mind is working" : mode === "ambient" ? "Mind is ready" : "";
    lastSentText = "";
    setState(recorder.isAmbientActive() ? "listening" : canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
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
      speechOutput.cancel("Speech off");
    } else {
      void speechOutput.speakReply("Mind voice is on.", { force: true });
    }
    setState(state);
  };
  const onSpeakTest = () => {
    void speechOutput.speakReply("This is Mind.", { force: true });
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
        recorder.cleanupPushRecorder();
        speechOutput.cancel("Speech unavailable while disconnected");
        recorder.stopAmbient();
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
      ? "Speak replies on"
      : "Speech off",
  );

  return {
    destroy() {
      destroyed = true;
      clearActivityHideTimer();
      clearPendingInterimSpeech();
      speechOutput.cancel();
      recorder.destroy();
      for (const remove of listeners) {
        remove();
      }
    },
  };
}
