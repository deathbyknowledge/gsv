#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";

import { AudioCapture, AudioPlayback, MockCapture, MockPlayback } from "./audio.mjs";
import { WearableController } from "./controller.mjs";
import { DisabledWearableDriver, MockWearableDriver, WearableDriver } from "./driver.mjs";
import { GsvBackend, MockBackend } from "./gateway.mjs";
import { IpcServer } from "./ipc.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const pocDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mock = args.includes("--mock") || process.env.GSV_HDZERO_MOCK === "1";
const clientOnly = args.includes("--gateway");
const requireDual = args.includes("--dual");
const socketPath = option(args, "--socket")
  || process.env.GSV_HDZERO_SOCKET
  || "/tmp/gsv-hdzero.sock";

let controller;
let backend;
let driver;
let ipc;
let shuttingDown = false;

async function main() {
  const audioConfig = {
    sampleFile: process.env.GSV_HDZERO_AUDIO_FILE,
    captureBin: process.env.GSV_HDZERO_CAPTURE_BIN,
    captureArgs: process.env.GSV_HDZERO_CAPTURE_ARGS,
    playbackBin: process.env.GSV_HDZERO_PLAYBACK_BIN,
    playbackArgs: process.env.GSV_HDZERO_PLAYBACK_ARGS,
  };
  const backendOptions = {
    onSignal: (signal, payload) => controller?.handleSignal(signal, payload),
    onStatus: (connection, status) => controller?.setClientConnection(connection, status),
  };
  backend = mock
    ? new MockBackend({
      transcript: process.env.GSV_HDZERO_MOCK_TRANSCRIPT,
      answer: process.env.GSV_HDZERO_MOCK_ANSWER,
    }, backendOptions)
    : new GsvBackend({
      url: process.env.GSV_GATEWAY_URL,
      username: process.env.GSV_USERNAME,
      password: process.env.GSV_PASSWORD,
      token: process.env.GSV_TOKEN,
      pid: process.env.GSV_PID,
      conversationId: process.env.GSV_CONVERSATION_ID,
      language: process.env.GSV_HDZERO_LANGUAGE,
      speechVoice: process.env.GSV_HDZERO_SPEECH_VOICE,
      speechMaxChars: process.env.GSV_HDZERO_SPEECH_MAX_CHARS,
    }, backendOptions);

  const capture = mock ? new MockCapture() : new AudioCapture(audioConfig);
  const playback = mock ? new MockPlayback() : new AudioPlayback(audioConfig);
  let latestSnapshot;
  controller = new WearableController({
    backend,
    capture,
    playback,
    publish: (snapshot) => {
      latestSnapshot = snapshot;
      ipc?.broadcast(snapshot);
    },
  });
  const deviceId = process.env.GSV_DEVICE_ID?.trim() || "hdzero-g2-emulator";
  const driverOptions = {
    getState: () => controller.publicDeviceState(),
    getPresentation: () => controller.presentationState(),
    onActivity: (activity) => controller.setDeviceActivity(activity),
    onPresent: (presentation) => controller.setPresentation(presentation),
    onStatus: (connection, status, id) => controller.setDriverConnection(connection, status, id),
  };
  if (mock) {
    driver = new MockWearableDriver({ deviceId }, driverOptions);
  } else if (!clientOnly && (process.env.GSV_DEVICE_TOKEN || requireDual)) {
    driver = new WearableDriver({
      url: process.env.GSV_GATEWAY_URL,
      username: process.env.GSV_USERNAME,
      token: process.env.GSV_DEVICE_TOKEN,
      deviceId,
      rootPath: process.env.GSV_DEVICE_ROOT
        || path.join(pocDirectory, ".work/device-root"),
      firmwareAppRoot: process.env.GSV_HDZERO_APP_ROOT
        || path.join(pocDirectory, ".work/hdzero-goggle/mkapp/app"),
    }, driverOptions);
  } else {
    driver = new DisabledWearableDriver({ deviceId }, driverOptions);
  }
  ipc = new IpcServer(socketPath, {
    getSnapshot: () => latestSnapshot,
    onAction: (action) => controller.handleAction(action),
  });
  await ipc.start();
  console.error(`[bridge] listening on ${socketPath}${mock ? " (mock wearable)" : ""}`);
  void backend.start();
  void driver.start().catch(() => {
    controller.setDriverConnection("offline", "Machine target failed to start", deviceId);
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await controller?.close().catch(() => {});
  await driver?.stop().catch(() => {});
  await backend?.stop().catch(() => {});
  await ipc?.stop().catch(() => {});
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

main().catch(async (error) => {
  console.error(`[bridge] ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown();
  process.exitCode = 1;
});
