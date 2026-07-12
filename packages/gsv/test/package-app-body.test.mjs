import assert from "node:assert/strict";
import test from "node:test";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  bodyFromBytes,
  bodyToBytes,
  buildBinaryFrame,
  parseBinaryFrame,
} from "../dist/protocol.js";

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance;

  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;
  sent = [];

  constructor() {
    super();
    FakeWebSocket.instance = this;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("package app kernel requests carry binary request and response bodies", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWindow = globalThis.window;
  const nativeWebSocket = globalThis.WebSocket;
  const packageWindow = {
    location: { href: "https://gsv.test/apps/demo/" },
    __GSV_APP_BOOT__: {
      packageId: "pkg-demo",
      packageName: "demo",
      routeBase: "/apps/demo",
      rpcBase: "/apps/demo/socket",
      sessionId: "session-1",
      clientId: "client-1",
      expiresAt: Date.now() + 3_600_000,
      hasBackend: true,
    },
  };
  packageWindow.parent = packageWindow;
  globalThis.window = packageWindow;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args);
    timer.unref?.();
    return timer;
  };

  try {
    const { createGsvClient } = await import("../dist/sdk/browser.js");
    const gsv = await createGsvClient();
    const socket = FakeWebSocket.instance;
    assert.equal(socket.binaryType, "arraybuffer");
    assert.equal(gsv.fs.read, undefined);
    assert.equal(typeof gsv.fs.write, "function");

    const transcription = gsv.request(
      "ai.transcription.create",
      { audio: { mimeType: "audio/webm" } },
      { body: bodyFromBytes(new Uint8Array([1, 2, 3])) },
    );
    await nextTurn();

    const uploadRequest = JSON.parse(socket.sent[0]);
    const uploadData = parseBinaryFrame(socket.sent[1]);
    const uploadEnd = parseBinaryFrame(socket.sent[2]);
    assert.equal(uploadRequest.call, "kernel.request");
    assert.equal(uploadRequest.args.call, "ai.transcription.create");
    assert.deepEqual(uploadRequest.body, { streamId: 1, length: 3 });
    assert.deepEqual([...uploadData.payload], [1, 2, 3]);
    assert.equal(uploadData.flags, BINARY_FRAME_DATA);
    assert.equal(uploadEnd.flags, BINARY_FRAME_END);

    socket.receive(JSON.stringify({
      type: "res",
      id: uploadRequest.id,
      ok: true,
      data: { text: "hello", provider: "workers-ai", model: "whisper" },
    }));
    assert.equal((await transcription).data.text, "hello");

    const speech = gsv.request("ai.speech.create", { text: "hello" });
    await nextTurn();
    const speechRequest = JSON.parse(socket.sent[3]);
    socket.receive(JSON.stringify({
      type: "res",
      id: speechRequest.id,
      ok: true,
      data: {
        audio: { mimeType: "audio/mpeg", size: 3 },
        provider: "workers-ai",
        model: "speech",
      },
      body: { streamId: 41, length: 3 },
    }));
    socket.receive(buildBinaryFrame(41, BINARY_FRAME_DATA, new Uint8Array([4, 5, 6])));
    socket.receive(buildBinaryFrame(41, BINARY_FRAME_END));

    const speechResponse = await speech;
    assert.deepEqual([...await bodyToBytes(speechResponse.body)], [4, 5, 6]);

    const backend = await gsv.backend();
    const backendCall = backend.echo({ value: 7 });
    await nextTurn();
    const backendRequest = JSON.parse(socket.sent[4]);
    assert.equal(backendRequest.call, "backend.invoke");
    socket.receive(JSON.stringify({
      type: "res",
      id: backendRequest.id,
      ok: true,
      data: { echoed: 7 },
    }));
    assert.deepEqual(await backendCall, { echoed: 7 });

    socket.receive(JSON.stringify({
      type: "res",
      id: "late-package-response",
      ok: true,
      body: { streamId: 42, length: 3 },
    }));
    await nextTurn();
    const cancelled = parseBinaryFrame(socket.sent.at(-1));
    assert.equal(cancelled.streamId, 42);
    assert.equal(cancelled.flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
  } finally {
    globalThis.fetch = nativeFetch;
    globalThis.setTimeout = nativeSetTimeout;
    if (nativeWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = nativeWindow;
    }
    if (nativeWebSocket === undefined) {
      delete globalThis.WebSocket;
    } else {
      globalThis.WebSocket = nativeWebSocket;
    }
  }
});
