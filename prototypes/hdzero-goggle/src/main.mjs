#!/usr/bin/env node

import { AudioCapture, AudioPlayback, MockCapture, MockPlayback } from "./audio.mjs";
import { VoiceController } from "./controller.mjs";
import { GsvBackend, MockBackend } from "./gateway.mjs";
import { IpcServer } from "./ipc.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
const mock = args.includes("--mock") || process.env.GSV_HDZERO_MOCK === "1";
const socketPath = option(args, "--socket")
  || process.env.GSV_HDZERO_SOCKET
  || "/tmp/gsv-hdzero.sock";

let controller;
let backend;
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
    onStatus: (connection, status) => controller?.setConnection(connection, status),
  };
  backend = mock
    ? new MockBackend({
      transcript: process.env.GSV_HDZERO_MOCK_TRANSCRIPT,
      answer: process.env.GSV_HDZERO_MOCK_ANSWER,
    }, backendOptions)
    : new GsvBackend({
      url: process.env.GSV_GATEWAY_URL,
      username: process.env.GSV_USERNAME,
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
  controller = new VoiceController({
    backend,
    capture,
    playback,
    publish: (snapshot) => {
      latestSnapshot = snapshot;
      ipc?.broadcast(snapshot);
    },
  });
  ipc = new IpcServer(socketPath, {
    getSnapshot: () => latestSnapshot,
    onCommand: (command) => controller.handleCommand(command),
  });
  await ipc.start();
  console.error(`[bridge] listening on ${socketPath}${mock ? " (mock gateway)" : ""}`);
  void backend.start();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await controller?.close().catch(() => {});
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
