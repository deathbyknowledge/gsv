const ACTIVE_PHASES = new Set([
  "recording",
  "transcribing",
  "thinking",
  "answering",
  "speaking",
]);

const MAX_TRANSCRIPT_CHARS = 2_000;
const MAX_ANSWER_CHARS = 8_000;
const MAX_BUFFERED_SIGNALS = 64;
const WEARABLE_VIEWS = ["conversation", "activity", "device", "presentation"];

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function boundedText(value, maxChars) {
  const text = asString(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class WearableController {
  constructor({
    backend,
    capture,
    playback,
    publish,
    answerDisplayMs = 10_000,
  }) {
    this.backend = backend;
    this.capture = capture;
    this.playback = playback;
    this.publish = publish;
    this.answerDisplayMs = answerDisplayMs;
    this.generation = 0;
    this.activeRunId = null;
    this.operationAbort = null;
    this.pendingSignals = [];
    this.idleTimer = null;
    this.closed = false;
    this.state = {
      type: "wearable.snapshot",
      view: "conversation",
      clientConnection: "offline",
      driverConnection: "offline",
      deviceId: "hdzero-g2-emulator",
      phase: "idle",
      speak: false,
      status: "Bridge starting",
      activity: "Wearable bridge starting",
      presentationKind: "none",
      presentationTitle: "",
      presentationBody: "",
      presentationPath: "",
      transcript: "",
      answer: "",
      error: "",
      runId: "",
    };
    this.publishState();
  }

  snapshot() {
    return { ...this.state };
  }

  setClientConnection(connection, status = "") {
    if (this.closed) {
      return;
    }
    this.state.clientConnection = connection;
    if (this.state.phase === "idle" || connection !== "online") {
      this.state.status = status || (connection === "online" ? "Ready" : "Gateway offline");
    }
    this.publishState();
  }

  setDriverConnection(connection, status = "", deviceId = this.state.deviceId) {
    if (this.closed) {
      return;
    }
    this.setState({
      driverConnection: connection,
      deviceId: boundedText(deviceId, 80) || this.state.deviceId,
      activity: boundedText(status, 160) || (connection === "online"
        ? "Machine target ready"
        : "Machine target offline"),
    });
  }

  setDeviceActivity(activity) {
    if (!this.closed) {
      this.setState({ activity: boundedText(activity, 160) });
    }
  }

  setPresentation(presentation) {
    if (this.closed) {
      return;
    }
    const kind = ["none", "text", "image"].includes(presentation?.kind)
      ? presentation.kind
      : "none";
    this.setState({
      presentationKind: kind,
      presentationTitle: boundedText(presentation?.title, 120),
      presentationBody: boundedText(presentation?.body, 6_000),
      presentationPath: boundedText(presentation?.path, 768),
      ...(kind === "none"
        ? { view: this.state.view === "presentation" ? "conversation" : this.state.view }
        : { view: "presentation" }),
    });
  }

  presentationState() {
    return {
      kind: this.state.presentationKind,
      title: this.state.presentationTitle,
      body: this.state.presentationBody,
    };
  }

  publicDeviceState() {
    return {
      clientConnection: this.state.clientConnection,
      driverConnection: this.state.driverConnection,
      phase: this.state.phase,
    };
  }

  async handleAction(action) {
    if (this.closed) {
      return;
    }
    const type = typeof action === "string" ? action : action?.type;
    if (type === "view.next" || type === "view.previous") {
      const current = WEARABLE_VIEWS.indexOf(this.state.view);
      const direction = type === "view.next" ? 1 : -1;
      const view = WEARABLE_VIEWS[(current + direction + WEARABLE_VIEWS.length) % WEARABLE_VIEWS.length];
      this.setState({ view });
      return;
    }
    if (type === "view.open" && WEARABLE_VIEWS.includes(action?.view)) {
      this.setState({ view: action.view });
      return;
    }
    if (type === "speech.toggle") {
      this.state.speak = !this.state.speak;
      this.publishState();
      return;
    }
    if (type === "request.cancel") {
      await this.cancel("Cancelled");
      return;
    }
    if (type !== "voice.toggle") {
      return;
    }
    if (this.state.phase === "recording") {
      await this.stopAndSubmit();
      return;
    }
    if (ACTIVE_PHASES.has(this.state.phase)) {
      await this.cancel("Superseded");
    }
    await this.startRecording();
  }

  async startRecording() {
    if (this.state.clientConnection !== "online") {
      this.fail("Gateway offline");
      return;
    }
    this.clearIdleTimer();
    const generation = ++this.generation;
    this.activeRunId = null;
    this.pendingSignals = [];
    this.operationAbort = new AbortController();
    this.setState({
      phase: "recording",
      status: "Recording — press again to send",
      transcript: "",
      answer: "",
      error: "",
      runId: "",
    });
    try {
      await this.capture.start(this.operationAbort.signal);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(errorMessage(error, "Microphone capture failed"));
      }
    }
  }

  async stopAndSubmit() {
    const generation = this.generation;
    this.setState({ phase: "transcribing", status: "Transcribing", error: "" });
    try {
      const audio = await this.capture.stop();
      if (!this.isCurrent(generation)) {
        return;
      }
      const result = await this.backend.transcribe(audio, this.operationAbort.signal);
      if (!this.isCurrent(generation)) {
        return;
      }
      const transcript = boundedText(result.text?.trim(), MAX_TRANSCRIPT_CHARS);
      if (!transcript) {
        this.fail("No speech detected");
        return;
      }
      this.setState({
        phase: "thinking",
        status: "Agent thinking",
        transcript,
        answer: "",
      });
      const sent = await this.backend.send(transcript);
      if (!this.isCurrent(generation)) {
        if (sent?.runId) {
          await this.backend.abort(sent.runId).catch(() => {});
        }
        return;
      }
      if (!sent?.ok || !sent.runId) {
        throw new Error(sent?.error || "Agent run did not start");
      }
      this.activeRunId = sent.runId;
      this.state.runId = sent.runId;
      this.publishState();
      const pending = this.pendingSignals;
      this.pendingSignals = [];
      for (const [signal, payload] of pending) {
        this.handleSignal(signal, payload);
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(errorMessage(error, "Voice request failed"));
      }
    }
  }

  handleSignal(signal, payload) {
    if (this.closed || !signal.startsWith("proc.run.")) {
      return;
    }
    const record = asRecord(payload);
    const runId = asString(record?.runId);
    if (!runId) {
      return;
    }
    if (!this.activeRunId) {
      if (this.state.phase === "thinking") {
        if (this.pendingSignals.length === MAX_BUFFERED_SIGNALS) {
          this.pendingSignals.shift();
        }
        this.pendingSignals.push([signal, payload]);
      }
      return;
    }
    if (runId !== this.activeRunId) {
      return;
    }

    if (signal === "proc.run.started") {
      this.setState({ phase: "thinking", status: "Agent thinking" });
      return;
    }
    if (signal === "proc.run.stream") {
      const event = asRecord(record.event);
      if (event?.type !== "text_delta") {
        return;
      }
      const delta = asString(event.delta);
      if (!delta) {
        return;
      }
      this.setState({
        phase: "answering",
        status: "Agent replying",
        answer: boundedText(this.state.answer + delta, MAX_ANSWER_CHARS),
      });
      return;
    }
    if (signal === "proc.run.output") {
      const text = boundedText(record.text, MAX_ANSWER_CHARS);
      if (text) {
        this.setState({ phase: "answering", status: "Agent replying", answer: text });
      }
      return;
    }
    if (signal === "proc.run.tool.started") {
      this.setState({ status: "Agent using a tool" });
      return;
    }
    if (signal === "proc.run.retrying") {
      this.setState({ status: "Agent retrying" });
      return;
    }
    if (signal === "proc.run.hil.requested") {
      this.setState({ status: "Approval needed in GSV" });
      return;
    }
    if (signal === "proc.run.finished") {
      const finalText = boundedText(record.text, MAX_ANSWER_CHARS);
      if (finalText && !this.state.answer) {
        this.state.answer = finalText;
      }
      const runError = asString(record.error);
      const finishedRunId = this.activeRunId;
      this.activeRunId = null;
      this.state.runId = "";
      if (runError) {
        this.fail(runError);
        return;
      }
      const generation = this.generation;
      if (this.state.speak && this.state.answer) {
        void this.speakAnswer(generation, finishedRunId, this.state.answer);
      } else {
        this.showAnswer();
      }
    }
  }

  async speakAnswer(generation, _runId, text) {
    this.setState({ phase: "speaking", status: "Speaking reply" });
    try {
      const audio = await this.backend.speak(text, this.operationAbort?.signal);
      if (!this.isCurrent(generation)) {
        return;
      }
      if (audio) {
        await this.playback.play(audio, this.operationAbort?.signal);
      }
      if (this.isCurrent(generation)) {
        this.showAnswer();
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.fail(errorMessage(error, "Speech playback failed"));
      }
    }
  }

  showAnswer() {
    this.setState({ phase: "answer", status: "Reply complete", error: "" });
    this.clearIdleTimer();
    if (this.answerDisplayMs >= 0) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.closed && this.state.phase === "answer") {
          this.setState({ phase: "idle", status: "Ready" });
        }
      }, this.answerDisplayMs);
      this.idleTimer.unref?.();
    }
  }

  async cancel(status = "Cancelled") {
    this.clearIdleTimer();
    ++this.generation;
    const runId = this.activeRunId;
    this.activeRunId = null;
    this.pendingSignals = [];
    this.operationAbort?.abort(new Error(status));
    this.operationAbort = null;
    await this.capture.cancel().catch(() => {});
    if (runId) {
      await this.backend.abort(runId).catch(() => {});
    }
    this.setState({ phase: "idle", status, error: "", runId: "" });
  }

  async close() {
    if (this.closed) {
      return;
    }
    await this.cancel("Bridge stopped");
    this.closed = true;
    this.clearIdleTimer();
  }

  fail(message) {
    this.activeRunId = null;
    this.operationAbort = null;
    this.setState({
      phase: "error",
      status: "Voice request failed",
      error: boundedText(message, 500),
      runId: "",
    });
  }

  isCurrent(generation) {
    return !this.closed && generation === this.generation;
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.publishState();
  }

  publishState() {
    this.publish(this.snapshot());
  }
}
