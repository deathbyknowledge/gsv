import assert from "node:assert/strict";
import test from "node:test";

import { VoiceController } from "../src/controller.mjs";

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeCapture {
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.cancelled = 0;
  }

  async start() {
    this.started += 1;
  }

  async stop() {
    this.stopped += 1;
    return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", filename: "voice.wav" };
  }

  async cancel() {
    this.cancelled += 1;
  }
}

class FakePlayback {
  constructor() {
    this.played = [];
  }

  async play(audio) {
    this.played.push(audio);
  }
}

function makeController(overrides = {}) {
  const snapshots = [];
  const capture = overrides.capture || new FakeCapture();
  const playback = overrides.playback || new FakePlayback();
  const backend = overrides.backend || {
    async transcribe() {
      return { text: "check the quad" };
    },
    async send() {
      return { ok: true, status: "started", runId: "run-1" };
    },
    async abort() {},
    async speak() {
      return { bytes: new Uint8Array([4, 5]), mimeType: "audio/wav" };
    },
  };
  const controller = new VoiceController({
    backend,
    capture,
    playback,
    publish: (snapshot) => snapshots.push(snapshot),
    answerDisplayMs: 60_000,
  });
  controller.setConnection("online", "Ready");
  return { backend, capture, controller, playback, snapshots };
}

test("runs capture, transcription, early run signals, streaming, and speech end to end", async () => {
  let controller;
  const backend = {
    async transcribe(audio) {
      assert.equal(audio.mimeType, "audio/wav");
      return { text: "  check the quad  " };
    },
    async send(message) {
      assert.equal(message, "check the quad");
      controller.handleSignal("proc.run.started", { runId: "run-race" });
      controller.handleSignal("proc.run.stream", {
        runId: "run-race",
        event: { type: "text_delta", delta: "Props clear. " },
      });
      controller.handleSignal("proc.run.output", {
        runId: "run-race",
        text: "Props clear. Battery secure.",
      });
      controller.handleSignal("proc.run.finished", { runId: "run-race" });
      return { ok: true, status: "started", runId: "run-race" };
    },
    async abort() {},
    async speak(text) {
      assert.equal(text, "Props clear. Battery secure.");
      return { bytes: new Uint8Array([9]), mimeType: "audio/wav" };
    },
  };
  const setup = makeController({ backend });
  controller = setup.controller;

  await controller.handleCommand("speech.toggle");
  await controller.handleCommand("ptt.toggle");
  assert.equal(controller.snapshot().phase, "recording");
  await controller.handleCommand("ptt.toggle");
  await tick();
  await tick();

  assert.equal(controller.snapshot().transcript, "check the quad");
  assert.equal(controller.snapshot().answer, "Props clear. Battery secure.");
  assert.equal(controller.snapshot().phase, "answer");
  assert.equal(setup.playback.played.length, 1);
  await controller.close();
});

test("cancellation aborts the active run and ignores late output", async () => {
  const aborted = [];
  const backend = {
    async transcribe() {
      return { text: "start a run" };
    },
    async send() {
      return { ok: true, status: "started", runId: "run-cancel" };
    },
    async abort(runId) {
      aborted.push(runId);
    },
    async speak() {
      throw new Error("must not speak");
    },
  };
  const { controller } = makeController({ backend });
  await controller.handleCommand("ptt.toggle");
  await controller.handleCommand("ptt.toggle");
  assert.equal(controller.snapshot().runId, "run-cancel");

  await controller.handleCommand("cancel");
  controller.handleSignal("proc.run.output", { runId: "run-cancel", text: "late" });
  controller.handleSignal("proc.run.finished", { runId: "run-cancel" });

  assert.deepEqual(aborted, ["run-cancel"]);
  assert.equal(controller.snapshot().phase, "idle");
  assert.equal(controller.snapshot().answer, "");
  await controller.close();
});

test("cancellation during transcription prevents a superseded agent run", async () => {
  const transcription = deferred();
  let sends = 0;
  const backend = {
    async transcribe() {
      return transcription.promise;
    },
    async send() {
      sends += 1;
      return { ok: true, status: "started", runId: "unexpected" };
    },
    async abort() {},
    async speak() {},
  };
  const { controller } = makeController({ backend });
  await controller.handleCommand("ptt.toggle");
  const submission = controller.handleCommand("ptt.toggle");
  await tick();
  assert.equal(controller.snapshot().phase, "transcribing");

  await controller.handleCommand("cancel");
  transcription.resolve({ text: "too late" });
  await submission;

  assert.equal(sends, 0);
  assert.equal(controller.snapshot().phase, "idle");
  await controller.close();
});
