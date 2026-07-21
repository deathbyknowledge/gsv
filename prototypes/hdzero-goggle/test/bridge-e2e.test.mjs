import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MockCapture, MockPlayback } from "../src/audio.mjs";
import { VoiceController } from "../src/controller.mjs";
import { MockBackend } from "../src/gateway.mjs";
import { IpcServer } from "../src/ipc.mjs";

function lineReader(socket) {
  const queued = [];
  const waiters = [];
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex !== -1) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queued.push(message);
      }
    }
  });
  return (predicate, timeoutMs = 3_000) => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex !== -1) {
      return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for bridge snapshot"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

test("drives the complete mock voice flow through the emulator IPC contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gsv-hdzero-e2e-"));
  const socketPath = path.join(directory, "bridge.sock");
  let controller;
  let ipc;
  let latest;
  const backend = new MockBackend({
    transcript: "is the whoop ready",
    answer: "Battery secure. Props clear.",
  }, {
    onSignal: (signal, payload) => controller?.handleSignal(signal, payload),
    onStatus: (connection, status) => controller?.setConnection(connection, status),
  });
  controller = new VoiceController({
    backend,
    capture: new MockCapture(),
    playback: new MockPlayback(),
    publish: (snapshot) => {
      latest = snapshot;
      ipc?.broadcast(snapshot);
    },
    answerDisplayMs: 60_000,
  });
  ipc = new IpcServer(socketPath, {
    getSnapshot: () => latest,
    onCommand: (command) => controller.handleCommand(command),
  });
  let socket;
  try {
    await ipc.start();
    await backend.start();
    socket = net.createConnection(socketPath);
    const next = lineReader(socket);
    await next((snapshot) => snapshot.connection === "online");

    socket.write('{"type":"ptt.toggle"}\n');
    await next((snapshot) => snapshot.phase === "recording");
    socket.write('{"type":"ptt.toggle"}\n');
    await next((snapshot) => snapshot.phase === "transcribing");
    const answer = await next((snapshot) => snapshot.phase === "answer");

    assert.equal(answer.transcript, "is the whoop ready");
    assert.equal(answer.answer, "Battery secure. Props clear.");
    assert.equal(answer.runId, "");
  } finally {
    socket?.destroy();
    await controller.close();
    await backend.stop();
    await ipc.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
