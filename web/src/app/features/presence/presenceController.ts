import type { AiTranscriptionCreateResult } from "@humansandmachines/gsv/protocol";
import type { GSVClient } from "@humansandmachines/gsv/client";
import {
  blobToDataUrl,
  canUseAmbientMode,
  canUseBrowserVoiceRecorder,
  presenceRecordingFilename,
  totalBlobSize,
} from "./audio";
import { AMBIENT_MIN_SEGMENT_BYTES, AMBIENT_MIN_SEGMENT_MS } from "./constants";
import {
  appendTranscript,
  compactPresenceStatus,
  formatError,
  statusText,
  statusKey,
  transcriptionNote,
  truncateActivityText,
} from "./display";
import {
  loadPresenceModePreference,
  loadSpeakRepliesPreference,
  savePresenceModePreference,
  saveSpeakRepliesPreference,
} from "./preferences";
import { createPresenceRecorder, type AmbientSegment } from "./recording";
import { createPresenceRunActivity } from "./runActivity";
import { createPresenceSpeechOutput } from "./speechOutput";
import type { PresenceLogStatus, PresenceMode, PresenceSendResult, PresenceState } from "./types";
import {
  createVoiceTimingTrace,
  logVoiceTimingTrace,
  markVoiceTiming,
  recordVoiceTimingFailure,
} from "./voiceTiming";

type PresenceGsvClient = Pick<GSVClient, "ai" | "isConnected" | "onSignal" | "onStatus" | "proc">;

export type PresenceLogEntry = {
  id: string;
  status: PresenceLogStatus;
  text: string;
  timestamp: number;
};

export type PresenceActivitySnapshot = {
  status: string;
  body: string;
  tone: string;
  compact: boolean;
};

export type PresenceSnapshot = {
  mode: PresenceMode;
  state: PresenceState;
  note: string;
  statusMessage?: string;
  panelOpen: boolean;
  transcript: string;
  lastSentText: string;
  speakReplies: boolean;
  speechStatus: string;
  connected: boolean;
  recorderAvailable: boolean;
  ambientAvailable: boolean;
  ambientActive: boolean;
  activeRunCount: number;
  fullStatus: string;
  compactStatus: string;
  listenButtonText: string;
  logRows: PresenceLogEntry[];
  activity: PresenceActivitySnapshot;
};

type PresenceMutableState = {
  mode: PresenceMode;
  state: PresenceState;
  note: string;
  statusMessage?: string;
  panelOpen: boolean;
  transcript: string;
  lastSentText: string;
  speakReplies: boolean;
  speechStatus: string;
  logRows: PresenceLogEntry[];
  activity: PresenceActivitySnapshot;
};

type PresenceSubscriber = () => void;

export class PresenceController {
  private readonly gatewayClient: PresenceGsvClient;
  private readonly subscribers = new Set<PresenceSubscriber>();
  private readonly speechOutput: ReturnType<typeof createPresenceSpeechOutput>;
  private readonly runActivity: ReturnType<typeof createPresenceRunActivity>;
  private readonly recorder: ReturnType<typeof createPresenceRecorder>;
  private readonly removeGatewayListeners: Array<() => void> = [];
  private destroyed = false;
  private ambientPendingJobs = 0;
  private logSequence = 0;
  private view: PresenceMutableState;

  constructor(gatewayClient: PresenceGsvClient) {
    this.gatewayClient = gatewayClient;
    const speakReplies = loadSpeakRepliesPreference();
    this.view = {
      mode: loadPresenceModePreference(),
      state: canUseBrowserVoiceRecorder() ? "idle" : "unsupported",
      note: "",
      statusMessage: undefined,
      panelOpen: false,
      transcript: "",
      lastSentText: "",
      speakReplies,
      speechStatus: speakReplies ? "Speak replies on" : "Speech off",
      logRows: [],
      activity: {
        status: "Paused",
        body: "Ready",
        tone: "idle",
        compact: true,
      },
    };

    this.speechOutput = createPresenceSpeechOutput({
      gatewayClient,
      getSpeakReplies: () => this.view.speakReplies,
      isDestroyed: () => this.destroyed,
      setSpeechStatus: (speechStatus) => this.updateView({ speechStatus }),
    });
    this.runActivity = createPresenceRunActivity({
      isConnected: () => this.gatewayClient.isConnected(),
      getSpeakReplies: () => this.view.speakReplies,
      getState: () => this.view.state,
      setState: (state) => this.setPresenceState(state),
      setNote: (note) => this.setNote(note),
      ambientIdleNote: () => this.ambientIdleNote(),
      updatePresenceLog: (logId, status, text) => this.updateLog(logId, status, text),
      showPresenceActivity: (status, body, tone) => this.showPresenceActivity(status, body, tone),
      renderIdlePresenceActivity: () => this.renderIdlePresenceActivity(),
      speechOutput: this.speechOutput,
    });
    this.recorder = createPresenceRecorder({
      isConnected: () => this.gatewayClient.isConnected(),
      isDestroyed: () => this.destroyed,
      isSpeechOutputPlaying: () => this.speechOutput.isPlaying(),
      cancelSpeechOutput: () => this.speechOutput.cancel(),
      activeRunCount: () => this.runActivity.activeRunCount(),
      hasAmbientPendingJobs: () => this.ambientPendingJobs > 0,
      ambientIdleNote: () => this.ambientIdleNote(),
      setPanelOpen: (open) => this.setPanelOpen(open),
      setNote: (note) => this.setNote(note),
      getState: () => this.view.state,
      setState: (state, message) => this.setPresenceState(state, message),
      transcribe: (blob, mimeType, startedAt) => this.transcribeBlob(blob, mimeType, startedAt),
      onPushTranscribed: (result) => {
        this.view.transcript = appendTranscript(this.view.transcript, result.text);
        this.view.note = transcriptionNote(result);
        this.setPresenceState("idle", "Transcribed");
      },
      onAmbientSegment: (segment) => this.queueAmbientSegment(segment),
    });

    this.view.note = this.view.mode === "ambient" ? "Mind is ready" : "";
    this.setPresenceState(this.view.state);
    this.removeGatewayListeners.push(
      gatewayClient.onSignal((signal, payload) => this.runActivity.handleSignal(signal, payload)),
      gatewayClient.onStatus((status) => {
        if (status.state !== "connected") {
          this.recorder.cleanupPushRecorder();
          this.speechOutput.cancel("Speech unavailable while disconnected");
          this.recorder.stopAmbient();
          this.setPresenceState(this.view.state === "unsupported" ? "unsupported" : "idle");
          return;
        }
        this.setPresenceState(canUseBrowserVoiceRecorder()
          ? this.view.state === "unsupported" ? "idle" : this.view.state
          : "unsupported");
      }),
    );
  }

  subscribe(subscriber: PresenceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  getSnapshot(): PresenceSnapshot {
    const connected = this.gatewayClient.isConnected();
    const activeRunCount = this.runActivity.activeRunCount();
    const recorderAvailable = canUseBrowserVoiceRecorder();
    const ambientAvailable = canUseAmbientMode();
    return {
      ...this.view,
      connected,
      recorderAvailable,
      ambientAvailable,
      ambientActive: this.recorder.isAmbientActive(),
      activeRunCount,
      fullStatus: this.view.statusMessage ?? statusText(this.view.state, connected, activeRunCount),
      compactStatus: compactPresenceStatus(this.view.state, connected, activeRunCount),
      listenButtonText: this.listenButtonText(),
      logRows: this.view.logRows.slice(),
    };
  }

  setPanelOpen(open: boolean): void {
    this.view.panelOpen = open;
    if (this.runActivity.activeRunCount() === 0 && !this.runActivity.hasActivityHideTimer()) {
      this.renderIdlePresenceActivity();
      return;
    }
    this.emit();
  }

  togglePanel(): void {
    this.setPanelOpen(!this.view.panelOpen);
    if (!this.view.panelOpen) {
      return;
    }
    this.setPresenceState(this.view.state);
  }

  setMode(nextMode: PresenceMode): void {
    if (this.view.mode === nextMode) {
      return;
    }
    if (this.view.state === "recording") {
      this.recorder.stopPushRecording();
    }
    if (this.recorder.isAmbientActive()) {
      this.recorder.stopAmbient();
    }
    this.view.mode = nextMode;
    savePresenceModePreference(nextMode);
    this.view.note = nextMode === "ambient" ? "Mind is ready" : "";
    this.setPresenceState(canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  }

  setTranscript(transcript: string): void {
    this.updateView({ transcript });
    this.setPresenceState(this.view.state);
  }

  async listen(): Promise<void> {
    if (this.view.mode === "ambient") {
      if (this.recorder.isAmbientActive()) {
        this.recorder.stopAmbient();
        return;
      }
      await this.recorder.startAmbient();
      return;
    }
    if (this.view.state === "recording") {
      this.recorder.stopPushRecording();
      return;
    }
    await this.recorder.startPushRecording();
  }

  async sendManualTextToPersonalAgent(): Promise<void> {
    const message = this.view.transcript.trim();
    if (!message || !this.gatewayClient.isConnected()) {
      return;
    }
    if (this.view.state === "recording") {
      this.recorder.stopPushRecording();
      return;
    }
    this.setPresenceState("sending", "Sending to Mind");
    const logId = this.addLog("Sending", message, Date.now());
    const timing = createVoiceTimingTrace("manual");
    timing.promptChars = message.length;
    try {
      markVoiceTiming(timing, "agent_send_started");
      const sent = await this.sendTextToPersonalAgent(message);
      markVoiceTiming(timing, "agent_send_done");
      timing.runId = sent.runId;
      this.view.lastSentText = message;
      this.view.transcript = "";
      this.view.note = sent.queued ? "Queued for Mind" : "Mind is working";
      this.updateLog(logId, sent.queued ? "Queued" : "Working");
      this.runActivity.trackRun(sent.runId, logId, message, sent.queued ? "Queued" : "Working", timing);
      if (this.runActivity.hasRun(sent.runId)) {
        this.setPresenceState(this.recorder.isAmbientActive() ? "listening" : "idle", this.view.note);
      }
    } catch (error) {
      const errorMessage = formatError(error);
      recordVoiceTimingFailure(timing, errorMessage);
      logVoiceTimingTrace(timing, "failed");
      this.updateLog(logId, "Failed", errorMessage);
      this.setPresenceState("error", errorMessage);
    }
  }

  clearTranscript(): void {
    this.view.transcript = "";
    this.view.note = this.recorder.isAmbientActive()
      ? this.ambientIdleNote()
      : this.runActivity.activeRunCount() > 0 ? "Mind is working" : this.view.mode === "ambient" ? "Mind is ready" : "";
    this.view.lastSentText = "";
    this.setPresenceState(this.recorder.isAmbientActive() ? "listening" : canUseBrowserVoiceRecorder() ? "idle" : "unsupported");
  }

  closePanel(): void {
    if (this.view.state === "recording") {
      this.recorder.stopPushRecording();
    }
    this.setPanelOpen(false);
  }

  setSpeakReplies(enabled: boolean): void {
    this.view.speakReplies = enabled;
    saveSpeakRepliesPreference(enabled);
    if (!enabled) {
      this.speechOutput.cancel("Speech off");
    } else {
      void this.speechOutput.speakReply("Mind voice is on.", { force: true });
    }
    this.setPresenceState(this.view.state);
  }

  previewSpeech(): void {
    void this.speechOutput.speakReply("This is Mind.", { force: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.runActivity.destroy();
    this.speechOutput.cancel();
    this.recorder.destroy();
    for (const remove of this.removeGatewayListeners) {
      remove();
    }
    this.removeGatewayListeners.length = 0;
    this.subscribers.clear();
  }

  private setPresenceState(next: PresenceState, message?: string): void {
    this.view.state = next;
    this.view.statusMessage = message;
    if (this.runActivity.activeRunCount() === 0 && !this.runActivity.hasActivityHideTimer()) {
      this.renderIdlePresenceActivity();
      return;
    }
    this.emit();
  }

  private setNote(note: string): void {
    this.view.note = note;
  }

  private async queueAmbientSegment(segment: AmbientSegment): Promise<void> {
    const durationMs = Date.now() - segment.startedAt;
    if (durationMs < AMBIENT_MIN_SEGMENT_MS || totalBlobSize(segment.chunks) < AMBIENT_MIN_SEGMENT_BYTES) {
      this.view.note = this.ambientIdleNote();
      this.setPresenceState("listening");
      return;
    }
    await this.processAmbientSegment(segment);
  }

  private async processAmbientSegment(segment: AmbientSegment): Promise<void> {
    this.ambientPendingJobs += 1;
    const timing = createVoiceTimingTrace("ambient", segment.startedAt);
    markVoiceTiming(timing, "speech_started", segment.startedAt);
    markVoiceTiming(timing, "speech_last_voice", segment.lastVoiceAt);
    markVoiceTiming(timing, "segment_stopped", segment.stoppedAt);
    const blob = new Blob(segment.chunks, { type: segment.mimeType });
    let logId: string | null = null;
    this.view.note = "Transcribing speech";
    if (!this.recorder.isAmbientCapturing()) {
      this.setPresenceState("transcribing");
    }
    try {
      markVoiceTiming(timing, "transcription_started");
      const result = await this.transcribeBlob(blob, segment.mimeType, segment.startedAt);
      markVoiceTiming(timing, "transcription_done");
      const text = result.text.trim();
      if (!text) {
        throw new Error("No speech was transcribed");
      }
      timing.promptChars = text.length;
      logId = this.addLog("Sending", text, segment.startedAt);
      this.view.note = "Sending ambient segment";
      if (!this.recorder.isAmbientCapturing()) {
        this.setPresenceState("sending");
      }
      markVoiceTiming(timing, "agent_send_started");
      const sent = await this.sendTextToPersonalAgent(text);
      markVoiceTiming(timing, "agent_send_done");
      timing.runId = sent.runId;
      this.view.lastSentText = text;
      this.view.note = sent.queued ? "Queued for Mind" : "Mind is working";
      this.updateLog(logId, sent.queued ? "Queued" : "Working");
      this.runActivity.trackRun(sent.runId, logId, text, sent.queued ? "Queued" : "Working", timing);
      if (this.view.transcript.trim() === text) {
        this.view.transcript = "";
      }
    } catch (error) {
      const message = formatError(error);
      recordVoiceTimingFailure(timing, message);
      logVoiceTimingTrace(timing, "failed");
      this.view.note = "";
      this.setPresenceState("error", "Ambient failed: " + message);
      if (logId) {
        this.updateLog(logId, "Failed", message);
      } else {
        this.addLog("Failed", message, segment.startedAt);
      }
    } finally {
      this.ambientPendingJobs = Math.max(0, this.ambientPendingJobs - 1);
      if (!this.destroyed && this.recorder.isAmbientActive() && !this.recorder.isAmbientCapturing() && this.view.state !== "error") {
        this.view.note = this.ambientIdleNote();
        this.setPresenceState(this.ambientPendingJobs > 0 ? "transcribing" : "listening");
      }
    }
  }

  private async transcribeBlob(blob: Blob, mimeType: string, startedAt = Date.now()): Promise<AiTranscriptionCreateResult> {
    const data = await blobToDataUrl(blob);
    const result = await this.gatewayClient.ai.transcription.create({
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

  private async sendTextToPersonalAgent(message: string): Promise<PresenceSendResult> {
    const spawned = await this.gatewayClient.proc.spawn({ label: "Mind" });
    if (!spawned.ok) {
      throw new Error(spawned.error);
    }
    const result = await this.gatewayClient.proc.send({
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

  private ambientIdleNote(): string {
    if (this.ambientPendingJobs > 0) {
      return `Processing ${this.ambientPendingJobs}`;
    }
    const activeRunCount = this.runActivity.activeRunCount();
    if (activeRunCount > 0) {
      return activeRunCount === 1 ? "Mind is working" : `${activeRunCount} Mind jobs running`;
    }
    return "Mind is listening";
  }

  private addLog(status: PresenceLogStatus, text: string, timestamp: number): string {
    const id = `presence-log-${++this.logSequence}`;
    this.view.logRows = [
      { id, status, text, timestamp },
      ...this.view.logRows,
    ].slice(0, 6);
    this.emit();
    return id;
  }

  private updateLog(logId: string | null, status: PresenceLogStatus, text?: string): void {
    if (!logId) {
      return;
    }
    this.view.logRows = this.view.logRows.map((row) => row.id === logId
      ? { ...row, status, text: typeof text === "string" ? text : row.text }
      : row);
    this.emit();
  }

  private showPresenceActivity(status: PresenceLogStatus, body: string, tone = statusKey(status)): void {
    this.view.activity = {
      status,
      body: truncateActivityText(body.trim() || status),
      tone,
      compact: false,
    };
    this.emit();
  }

  private renderIdlePresenceActivity(): void {
    const connected = this.gatewayClient.isConnected();
    const status = compactPresenceStatus(this.view.state, connected, this.runActivity.activeRunCount());
    const body = this.presenceActivityBody(this.view.state, connected);
    this.view.activity = {
      status,
      body,
      tone: this.presenceActivityTone(this.view.state, connected),
      compact: this.shouldCompactPresenceActivity(this.view.state, connected),
    };
    this.emit();
  }

  private presenceActivityTone(current: PresenceState, connected: boolean): string {
    if (!connected) {
      return "failed";
    }
    if (this.runActivity.activeRunCount() > 0) {
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

  private shouldCompactPresenceActivity(current: PresenceState, connected: boolean): boolean {
    return connected
      && !this.view.panelOpen
      && this.runActivity.activeRunCount() === 0
      && (current === "idle" || current === "listening" || current === "unsupported");
  }

  private presenceActivityBody(current: PresenceState, connected: boolean): string {
    if (!connected) {
      return "Gateway disconnected";
    }
    if (this.view.note) {
      return this.view.note;
    }
    switch (current) {
      case "listening": return "Listening";
      case "capturing": return "Heard you";
      case "recording": return "Recording";
      case "transcribing": return "Transcribing speech";
      case "sending": return "Sending";
      case "error": return "Needs attention";
      case "unsupported": return "Voice unavailable";
      default: return this.view.mode === "ambient" ? "Click to start listening" : "Ready";
    }
  }

  private listenButtonText(): string {
    if (this.view.mode === "ambient") {
      return this.recorder.isAmbientActive() ? "Pause" : "Listen";
    }
    return this.view.state === "recording" ? "Stop" : "Record";
  }

  private updateView(partial: Partial<PresenceMutableState>): void {
    this.view = { ...this.view, ...partial };
    this.emit();
  }

  private emit(): void {
    for (const subscriber of this.subscribers) {
      subscriber();
    }
  }
}
