import { GSVClient } from "@humansandmachines/gsv/client";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";

import { connectionFailureReason, ReconnectSupervisor } from "./reconnect.mjs";

const MAX_SPEECH_BYTES = 16 * 1024 * 1024;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Stopped"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required unless --mock is used`);
  }
  return normalized;
}

function userCredential(config) {
  const password = config.password?.trim();
  const token = config.token?.trim();
  if (password && token) {
    throw new Error("Set only one of GSV_PASSWORD or GSV_TOKEN");
  }
  if (!password && !token) {
    throw new Error("GSV_PASSWORD or GSV_TOKEN is required unless --mock is used");
  }
  return password ? { password } : { token };
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class GsvBackend {
  constructor(config, { onSignal, onStatus, log = console.error }) {
    this.config = {
      url: required(config.url, "GSV_GATEWAY_URL"),
      username: required(config.username, "GSV_USERNAME"),
      ...userCredential(config),
      pid: config.pid?.trim() || undefined,
      conversationId: config.conversationId?.trim() || undefined,
      language: config.language?.trim() || undefined,
      speechVoice: config.speechVoice?.trim() || undefined,
      speechMaxChars: positiveInt(config.speechMaxChars, 3_500),
    };
    this.onStatusChange = onStatus;
    this.log = log;
    this.client = new GSVClient({
      WebSocket: globalThis.WebSocket,
      client: {
        id: "hdzero-wearable",
        version: "0.2.0",
        platform: "hdzero-emulator",
        role: "user",
      },
    });
    this.connection = new ReconnectSupervisor({
      isConnected: () => this.client.isConnected(),
      connect: () => this.client.connect({
        url: this.config.url,
        username: this.config.username,
        ...(this.config.password
          ? { password: this.config.password }
          : { token: this.config.token }),
      }),
      onRetry: (error, retryMs) => {
        const reason = connectionFailureReason(error, [this.config.password, this.config.token]);
        this.log(`[bridge] gateway connect failed: ${reason}; retrying in ${retryMs}ms`);
      },
    });
    this.unsubscribeSignal = this.client.onSignal(onSignal);
    this.unsubscribeStatus = this.client.onStatus((status) => {
      if (status.state === "connected") {
        this.onStatusChange("online", "Ready");
      } else if (status.state === "connecting") {
        this.onStatusChange("connecting", "Connecting to gateway");
      } else {
        this.onStatusChange("offline", "Gateway offline");
        this.connection.disconnected();
      }
    });
  }

  start() {
    return this.connection.start();
  }

  async transcribe(audio, signal) {
    const response = await this.client.request("ai.transcription.create", {
      ...(this.config.pid ? { pid: this.config.pid } : {}),
      audio: {
        mimeType: audio.mimeType,
        ...(audio.filename ? { filename: audio.filename } : {}),
      },
      ...(this.config.language ? { language: this.config.language } : {}),
    }, {
      body: bodyFromBytes(audio.bytes),
      signal,
    });
    await response.body?.stream.cancel("Transcription response body is unsupported").catch(() => {});
    return response.data;
  }

  send(message) {
    return this.client.proc.send({
      ...(this.config.pid ? { pid: this.config.pid } : {}),
      ...(this.config.conversationId ? { conversationId: this.config.conversationId } : {}),
      message,
    });
  }

  abort(runId) {
    return this.client.proc.abort({
      ...(this.config.pid ? { pid: this.config.pid } : {}),
      runId,
    });
  }

  async speak(text, signal) {
    const response = await this.client.request("ai.speech.create", {
      text: text.slice(0, this.config.speechMaxChars),
      textFormat: "markdown",
      ...(this.config.speechVoice ? { voice: this.config.speechVoice } : {}),
    }, { signal });
    if (response.data.skipped || response.data.audio.size === 0) {
      await response.body?.stream.cancel("Speech synthesis was skipped").catch(() => {});
      return null;
    }
    if (!response.body) {
      throw new Error("Speech response did not include audio");
    }
    return {
      bytes: await bodyToBytes(response.body, MAX_SPEECH_BYTES, signal),
      mimeType: response.data.audio.mimeType,
    };
  }

  async stop() {
    this.unsubscribeSignal();
    this.unsubscribeStatus();
    const stopped = this.connection.stop();
    this.client.close();
    await stopped;
  }
}

export class MockBackend {
  constructor(config, { onSignal, onStatus }) {
    this.transcript = config.transcript || "What needs my attention today?";
    this.answer = config.answer || "Your morning brief is ready. One agent is active and there are no pending approvals.";
    this.onSignal = onSignal;
    this.onStatus = onStatus;
    this.runNumber = 0;
    this.timers = new Set();
    this.aborted = new Set();
  }

  async start() {
    this.onStatus("connecting", "Starting mock gateway");
    await delay(80);
    this.onStatus("online", "Ready — mock gateway");
  }

  async transcribe(_audio, signal) {
    await this.wait(350, signal);
    return { text: this.transcript, provider: "mock", model: "mock-stt" };
  }

  async send(_message) {
    const runId = `mock-run-${++this.runNumber}`;
    this.schedule(20, () => this.emit("proc.run.started", { runId }));
    const chunks = this.answer.match(/.{1,18}(?:\s|$)/g) || [this.answer];
    let elapsed = 220;
    for (const chunk of chunks) {
      this.schedule(elapsed, () => this.emit("proc.run.stream", {
        runId,
        event: { type: "text_delta", delta: chunk },
      }));
      elapsed += 110;
    }
    this.schedule(elapsed, () => this.emit("proc.run.output", { runId, text: this.answer }));
    this.schedule(elapsed + 30, () => this.emit("proc.run.finished", { runId }));
    return { ok: true, status: "started", runId };
  }

  async abort(runId) {
    this.aborted.add(runId);
    return { ok: true, pid: "mock", aborted: true, runId };
  }

  async speak(_text, signal) {
    await this.wait(150, signal);
    return null;
  }

  async stop() {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.onStatus("offline", "Mock gateway stopped");
  }

  emit(signal, payload) {
    if (!this.aborted.has(payload.runId)) {
      this.onSignal(signal, payload);
    }
  }

  schedule(ms, callback) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }

  wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
