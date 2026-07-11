import {
  INTERIM_SPEECH_COOLDOWN_MS,
  MAX_BUFFERED_RUN_SIGNALS,
  RUN_SIGNAL_BUFFER_TTL_MS,
} from "./constants";
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
import type { PresenceSpeechOutput } from "./speechOutput";
import type {
  BufferedRunSignal,
  PresenceLogStatus,
  PresenceRun,
  PresenceState,
  VoiceTimingTrace,
} from "./types";
import {
  logVoiceTimingTrace,
  markRunActivity,
  markVoiceTiming,
  markVoiceTimingOnce,
} from "./voiceTiming";

type PresenceRunActivityOptions = {
  isConnected(): boolean;
  getSpeakReplies(): boolean;
  getState(): PresenceState;
  setState(state: PresenceState): void;
  setNote(note: string): void;
  ambientIdleNote(): string;
  updatePresenceLog(logId: string | null, status: PresenceLogStatus, text?: string): void;
  showPresenceActivity(status: PresenceLogStatus, body: string, tone?: string): void;
  renderIdlePresenceActivity(): void;
  speechOutput: Pick<PresenceSpeechOutput, "finalizeRunSpeech" | "queueRunSpeechFromAnswer" | "speakReply">;
};

export type PresenceRunActivity = {
  activeRunCount(): number;
  hasActivityHideTimer(): boolean;
  hasRun(runId: string): boolean;
  trackRun(
    runId: string,
    logId: string | null,
    prompt: string,
    status?: PresenceLogStatus,
    timing?: VoiceTimingTrace,
  ): void;
  handleSignal(signal: string, payload: unknown): void;
  destroy(): void;
};

export function createPresenceRunActivity(options: PresenceRunActivityOptions): PresenceRunActivity {
  let latestRunId: string | null = null;
  let activityHideTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInterimSpeechKey = "";
  let lastInterimSpeechAt = 0;
  const activeRuns = new Map<string, PresenceRun>();
  const bufferedRunSignals = new Map<string, BufferedRunSignal[]>();

  function activeRunCount(): number {
    return activeRuns.size;
  }

  function hasActivityHideTimer(): boolean {
    return activityHideTimer !== null;
  }

  function hasRun(runId: string): boolean {
    return activeRuns.has(runId);
  }

  function trackRun(
    runId: string,
    logId: string | null,
    prompt: string,
    status: PresenceLogStatus = "Working",
    timing?: VoiceTimingTrace,
  ): void {
    if (timing) {
      timing.runId = runId;
    }
    activeRuns.set(runId, {
      logId,
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
      options.setState(options.getState());
    }
  }

  function handleSignal(signal: string, payload: unknown): void {
    const runId = runIdFromSignalPayload(payload);
    if (!runId) {
      return;
    }
    const run = activeRuns.get(runId);
    if (!run) {
      bufferRunSignal(runId, signal, payload);
      return;
    }
    const isLatestRun = latestRunId === runId;
    if (!isLatestRun && signal !== "proc.run.finished") {
      return;
    }
    markRunActivity(run, signal);

    if (signal === "proc.run.retrying") {
      run.status = "Working";
      run.updatedAt = Date.now();
      latestRunId = runId;
      options.updatePresenceLog(run.logId, "Working");
      options.setNote("Mind is retrying");
      showPresenceActivity("Working", run.answer || run.prompt);
      options.setState(options.getState());
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
        options.updatePresenceLog(run.logId, "Responding");
        options.setNote("Mind is responding");
        showPresenceActivity("Responding", run.answer || run.prompt);
        options.speechOutput.queueRunSpeechFromAnswer(run, false);
        options.setState(options.getState());
        return;
      }

      const toolLabel = signalPayloadStreamToolLabel(payload);
      if (toolLabel) {
        markVoiceTimingOnce(run.timing, "agent_first_tool_call");
        run.status = "Using tools";
        run.updatedAt = Date.now();
        latestRunId = runId;
        options.updatePresenceLog(run.logId, "Using tools");
        options.setNote(`Mind is using ${toolLabel}`);
        showPresenceActivity("Using tools", `Using ${toolLabel}`);
        speakInterimStatus(`Using ${toolLabel}.`, `tool:${runId}:${toolLabel}`);
        options.setState(options.getState());
        return;
      }

      return;
    }

    if (signal === "proc.run.output") {
      markVoiceTimingOnce(run.timing, "agent_first_text");
      run.status = "Responding";
      run.updatedAt = Date.now();
      run.answer = signalPayloadText(payload) ?? run.answer;
      latestRunId = runId;
      options.updatePresenceLog(run.logId, "Responding");
      options.setNote("Mind is responding");
      showPresenceActivity("Responding", run.answer || run.prompt);
      options.setState(options.getState());
      return;
    }

    if (signal === "proc.run.tool.started") {
      const toolLabel = signalPayloadToolLabel(payload);
      markVoiceTiming(run.timing, "agent_first_tool_call");
      run.status = "Using tools";
      run.updatedAt = Date.now();
      latestRunId = runId;
      options.updatePresenceLog(run.logId, "Using tools");
      options.setNote(toolLabel ? `Mind is using ${toolLabel}` : "Mind is using tools");
      showPresenceActivity("Using tools", toolLabel ? `Using ${toolLabel}` : run.answer || run.prompt);
      speakInterimStatus(toolLabel ? `Using ${toolLabel}.` : "Using tools.", `tool:${runId}:${toolLabel ?? ""}`);
      options.setState(options.getState());
      return;
    }

    if (signal === "proc.run.hil.requested") {
      markVoiceTiming(run.timing, "agent_needs_approval");
      run.status = "Needs approval";
      run.updatedAt = Date.now();
      latestRunId = runId;
      options.updatePresenceLog(run.logId, "Needs approval");
      options.setNote("Mind needs approval");
      showPresenceActivity("Needs approval", run.answer || run.prompt, "needs-approval");
      speakInterimStatus("I need approval to continue.", `hil:${runId}`);
      options.setState(options.getState());
      return;
    }

    if (signal === "proc.run.finished") {
      const error = signalPayloadError(payload);
      const aborted = signalPayloadAborted(payload);
      run.answer = signalPayloadText(payload) ?? run.answer;
      markVoiceTiming(run.timing, "agent_complete");
      if (run.timing) {
        run.timing.answerChars = run.answer.length;
      }
      const finalStatus = error ? "Failed" : aborted ? "Stopped" : "Done";
      options.updatePresenceLog(run.logId, finalStatus, error ?? undefined);
      activeRuns.delete(runId);
      if (!isLatestRun) {
        if (run.timing) {
          logVoiceTimingTrace(run.timing, finalStatus.toLowerCase());
        }
        options.setState(options.getState());
        return;
      }
      options.setNote(
        error
          ? `Mind failed: ${error}`
          : aborted ? "Mind stopped" : activeRuns.size > 0 ? options.ambientIdleNote() : "Mind finished",
      );
      showPresenceActivity(
        finalStatus,
        error ?? (run.answer || run.prompt),
        finalStatus === "Failed" ? "failed" : finalStatus === "Stopped" ? "stopped" : "done",
      );
      if (!error && !aborted && run.answer) {
        if (!options.speechOutput.finalizeRunSpeech(run)) {
          void options.speechOutput.speakReply(run.answer, { timing: run.timing });
        }
      } else if (run.timing) {
        logVoiceTimingTrace(run.timing, finalStatus.toLowerCase());
      }
      scheduleActivityAfterCompletion(runId);
      options.setState(error ? "error" : options.getState());
    }
  }

  function destroy(): void {
    clearActivityHideTimer();
  }

  function showPresenceActivity(status: PresenceLogStatus, body: string, tone?: string): void {
    clearActivityHideTimer();
    options.showPresenceActivity(status, body, tone);
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
      .forEach((entry) => handleSignal(entry.signal, entry.payload));
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
      globalThis.clearTimeout(activityHideTimer);
      activityHideTimer = null;
    }
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
      options.renderIdlePresenceActivity();
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
    activityHideTimer = globalThis.setTimeout(() => {
      activityHideTimer = null;
      renderLatestActiveActivity();
    }, activeRuns.size > 0 ? 4500 : 12000);
  }

  function speakInterimStatus(text: string, key: string): void {
    if (!options.getSpeakReplies() || !options.isConnected()) {
      return;
    }
    const now = Date.now();
    if (key === lastInterimSpeechKey && now - lastInterimSpeechAt < INTERIM_SPEECH_COOLDOWN_MS) {
      return;
    }
    lastInterimSpeechKey = key;
    lastInterimSpeechAt = now;
    void options.speechOutput.speakReply(text, { interrupt: false });
  }

  return {
    activeRunCount,
    hasActivityHideTimer,
    hasRun,
    trackRun,
    handleSignal,
    destroy,
  };
}
