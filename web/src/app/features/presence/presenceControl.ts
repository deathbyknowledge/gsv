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
import { createPresenceRunActivity } from "./runActivity";
import { createPresenceSpeechOutput } from "./speechOutput";
import type {
  PresenceLogStatus,
  PresenceMode,
  PresenceSendResult,
  PresenceState,
} from "./types";
import {
  createVoiceTimingTrace,
  logVoiceTimingTrace,
  markVoiceTiming,
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
  let speakReplies = loadSpeakRepliesPreference();
  let ambientPendingJobs = 0;
  const speechOutput = createPresenceSpeechOutput({
    gatewayClient,
    getSpeakReplies: () => speakReplies,
    isDestroyed: () => destroyed,
    setSpeechStatus,
  });
  const runActivity = createPresenceRunActivity({
    isConnected: () => gatewayClient.isConnected(),
    getSpeakReplies: () => speakReplies,
    getState: () => state,
    setState,
    setNote: (nextNote) => {
      note = nextNote;
    },
    ambientIdleNote,
    showPresenceActivity,
    renderIdlePresenceActivity,
    speechOutput,
  });
  const recorder = createPresenceRecorder({
    isConnected: () => gatewayClient.isConnected(),
    isDestroyed: () => destroyed,
    isSpeechOutputPlaying: () => speechOutput.isPlaying(),
    cancelSpeechOutput: () => speechOutput.cancel(),
    activeRunCount: () => runActivity.activeRunCount(),
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
    if (runActivity.activeRunCount() === 0 && !runActivity.hasActivityHideTimer()) {
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
    const activeRunCount = runActivity.activeRunCount();
    const fullStatus = message ?? statusText(next, connected, activeRunCount);
    const compactStatus = compactPresenceStatus(next, connected, activeRunCount);
    statusTextNode.textContent = fullStatus;
    for (const compactStatusNode of compactStatusNodes) {
      compactStatusNode.textContent = compactStatus;
    }
    panelNode.dataset.state = next;
    panelNode.dataset.agent = activeRunCount > 0 ? "active" : "idle";
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
      toggle.dataset.agent = activeRunCount > 0 ? "active" : "idle";
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
    if (activeRunCount === 0 && !runActivity.hasActivityHideTimer()) {
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
      runActivity.trackRun(sent.runId, logRow, text, sent.queued ? "Queued" : "Working", timing);
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
    const activeRunCount = runActivity.activeRunCount();
    if (activeRunCount > 0) {
      return activeRunCount === 1 ? "Mind is working" : `${activeRunCount} Mind jobs running`;
    }
    return "Mind is listening";
  }

  function showPresenceActivity(status: PresenceLogStatus, body: string, tone = statusKey(status)): void {
    if (!activityNode || !activityStatusNode || !activityBodyNode) {
      return;
    }
    activityNode.hidden = false;
    activityNode.classList.remove("is-compact");
    activityNode.dataset.status = tone;
    activityStatusNode.textContent = status;
    activityBodyNode.textContent = truncateActivityText(body.trim() || status);
    activityNode.title = `Mind: ${status}`;
    activityNode.setAttribute("aria-label", `Mind: ${status}`);
  }

  function renderIdlePresenceActivity(): void {
    if (!activityNode || !activityStatusNode || !activityBodyNode) {
      return;
    }
    const connected = gatewayClient.isConnected();
    const activeRunCount = runActivity.activeRunCount();
    const status = compactPresenceStatus(state, connected, activeRunCount);
    const body = presenceActivityBody(state, connected);
    activityNode.hidden = false;
    activityNode.dataset.status = presenceActivityTone(state, connected);
    activityNode.classList.toggle("is-compact", shouldCompactPresenceActivity(state, connected));
    activityStatusNode.textContent = status;
    activityBodyNode.textContent = body;
    activityNode.title = `Mind: ${body}`;
    activityNode.setAttribute("aria-label", `Mind: ${status}. ${body}`);
  }

  function presenceActivityTone(current: PresenceState, connected: boolean): string {
    if (!connected) {
      return "failed";
    }
    if (runActivity.activeRunCount() > 0) {
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
      && runActivity.activeRunCount() === 0
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
      runActivity.trackRun(sent.runId, logRow, message, sent.queued ? "Queued" : "Working", timing);
      if (runActivity.hasRun(sent.runId)) {
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
      : runActivity.activeRunCount() > 0 ? "Mind is working" : mode === "ambient" ? "Mind is ready" : "";
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
    gatewayClient.onSignal(runActivity.handleSignal),
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
      runActivity.destroy();
      speechOutput.cancel();
      recorder.destroy();
      for (const remove of listeners) {
        remove();
      }
    },
  };
}
