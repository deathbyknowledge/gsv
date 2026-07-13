import assert from "node:assert/strict";
import test from "node:test";
import { GSVClient } from "../dist/client.js";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  buildBinaryFrame,
  parseBinaryFrame,
} from "../dist/protocol/binary-frame.js";
import { BinaryBodyChannel } from "../dist/protocol/binary-body-channel.js";
import { bodyFromBytes, bodyToBytes } from "../dist/protocol/body.js";
import { REQUEST_CANCEL_SIGNAL } from "../dist/protocol.js";
import {
  inferFsContentType,
  isTextContentType,
} from "../dist/protocol/file-content.js";

class FakeWebSocket extends EventTarget {
  static instance;

  binaryType = "blob";
  readyState = 0;
  sent = [];
  closeCalls = [];
  connectSignals = ["device.pong"];

  constructor() {
    super();
    FakeWebSocket.instance = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data) {
    this.sent.push(data);
    if (typeof data !== "string") {
      return;
    }
    const frame = JSON.parse(data);
    if (frame.call === "sys.connect") {
      queueMicrotask(() => this.receive(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        data: {
          protocol: 2,
          server: { connectionId: "test" },
          identity: { role: "user" },
          syscalls: [],
          signals: this.connectSignals,
        },
      })));
    }
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

class OpeningWebSocket extends EventTarget {
  static instance;

  binaryType = "blob";
  readyState = 0;
  closeCalls = [];

  constructor() {
    super();
    OpeningWebSocket.instance = this;
  }

  send() {}

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

class SignalFailingWebSocket extends FakeWebSocket {
  send(data) {
    if (typeof data === "string" && JSON.parse(data).type === "sig") {
      throw new Error("send failed");
    }
    super.send(data);
  }
}

class LegacyGatewayWebSocket extends FakeWebSocket {
  connectSignals = [];
}

function body(bytes) {
  return {
    length: bytes.byteLength,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

async function connectedClient() {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  await client.connect({
    url: "ws://test",
    username: "test",
    password: "test",
  });
  return { client, socket: FakeWebSocket.instance };
}

test("closes a WebSocket that is still opening when the connection is cancelled", async () => {
  const client = new GSVClient({ WebSocket: OpeningWebSocket });
  const connecting = client.connect({
    url: "ws://test",
    username: "test",
    password: "test",
  });
  await Promise.resolve();

  client.disconnect("connection settings changed");

  await assert.rejects(connecting, /closed during connect/);
  assert.deepEqual(OpeningWebSocket.instance.closeCalls, [{
    code: 1000,
    reason: "connection settings changed",
  }]);
});

test("closes an established WebSocket immediately when it errors", async () => {
  const { client, socket } = await connectedClient();

  socket.dispatchEvent(new Event("error"));

  assert.equal(client.getStatus().state, "disconnected");
  assert.equal(client.getStatus().message, "WebSocket error");
  assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: "WebSocket error" }]);
});

test("keeps body-bearing syscalls off the data-only namespaces", () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });

  assert.equal(client.fs.read, undefined);
  assert.equal(client.fs.transfer.send, undefined);
  assert.equal(client.fs.transfer.receive, undefined);
  assert.equal(client.net, undefined);
  assert.equal(client.proc.media.read, undefined);
  assert.equal(client.proc.media.write, undefined);
  assert.equal(typeof client.proc.media.delete, "function");
  assert.equal(client.ai.transcription, undefined);
  assert.equal(client.ai.image, undefined);
  assert.equal(client.ai.speech, undefined);
  assert.equal(typeof client.fs.transfer.stat, "function");
});

test("bodyFromBytes preserves its input buffer", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const framed = bodyFromBytes(bytes);

  assert.deepEqual(
    [...new Uint8Array(await new Response(framed.stream).arrayBuffer())],
    [1, 2, 3],
  );
  assert.equal(bytes.byteLength, 3);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("bodyFromBytes supports an empty body", async () => {
  const framed = bodyFromBytes(new Uint8Array());

  assert.equal(framed.length, 0);
  assert.equal((await new Response(framed.stream).arrayBuffer()).byteLength, 0);
});

test("bodyToBytes cancels an active read with its signal", async () => {
  const controller = new AbortController();
  let cancelled;
  const body = {
    stream: new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: (reason) => {
        cancelled = reason;
      },
    }),
  };
  const reading = bodyToBytes(body, Infinity, controller.signal);
  const reason = new Error("Run stopped");

  controller.abort(reason);

  await assert.rejects(reading, /Run stopped/);
  assert.equal(cancelled, reason);
});

test("parses binary frame payloads without copying them", () => {
  const encoded = buildBinaryFrame(7, BINARY_FRAME_DATA, new Uint8Array([1, 2, 3]));
  const parsed = parseBinaryFrame(encoded);

  assert.equal(parsed.payload.buffer, encoded);
  assert.equal(parsed.payload.byteOffset, 5);
  assert.deepEqual([...parsed.payload], [1, 2, 3]);
});

test("shares the filesystem content contract", () => {
  assert.equal(inferFsContentType("notes.unknown"), "text/plain");
  assert.equal(inferFsContentType("recording.webm"), "audio/webm");
  assert.equal(inferFsContentType("app.tsx"), "application/typescript");
  assert.equal(isTextContentType("application/problem+json; charset=utf-8"), true);
  assert.equal(isTextContentType("application/pdf"), false);
});

test("sends a request body after its JSON descriptor", async () => {
  const { client, socket } = await connectedClient();
  const pending = client.request("test.echo", {}, {
    body: body(new Uint8Array([1, 2, 3])),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = JSON.parse(socket.sent.at(-3));
  const data = parseBinaryFrame(socket.sent.at(-2));
  const end = parseBinaryFrame(socket.sent.at(-1));

  assert.deepEqual(request.body, { streamId: 1, length: 3 });
  assert.deepEqual([...data.payload], [1, 2, 3]);
  assert.equal(data.flags, BINARY_FRAME_DATA);
  assert.equal(end.flags, BINARY_FRAME_END);

  socket.receive(JSON.stringify({ type: "res", id: request.id, ok: true, data: { ok: true } }));
  assert.deepEqual((await pending).data, { ok: true });
  client.close();
});

test("exposes a response body as a stream", async () => {
  const { client, socket } = await connectedClient();
  const pending = client.request("test.echo");
  const request = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "res",
    id: request.id,
    ok: true,
    data: { ok: true },
    body: { streamId: 42, length: 3 },
  }));
  socket.receive(buildBinaryFrame(42, BINARY_FRAME_DATA, new Uint8Array([4, 5, 6])));
  socket.receive(buildBinaryFrame(42, BINARY_FRAME_END));

  const response = await pending;
  assert.equal(response.body.length, 3);
  assert.deepEqual(
    [...new Uint8Array(await new Response(response.body.stream).arrayBuffer())],
    [4, 5, 6],
  );
  client.close();
});

test("rejects a body that does not match its declared length", async () => {
  const { client, socket } = await connectedClient();
  const pending = client.request("test.echo");
  const request = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "res",
    id: request.id,
    ok: true,
    body: { streamId: 43, length: 3 },
  }));
  socket.receive(buildBinaryFrame(43, BINARY_FRAME_DATA, new Uint8Array([1, 2])));
  socket.receive(buildBinaryFrame(43, BINARY_FRAME_END));

  const response = await pending;
  await assert.rejects(
    new Response(response.body.stream).arrayBuffer(),
    /Body length 2 did not match 3/,
  );
  client.close();
});

test("treats response body timeouts as idle timeouts", async () => {
  const client = new GSVClient({
    WebSocket: FakeWebSocket,
    body: { receiveTimeoutMs: 100 },
  });
  await client.connect({
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;
  const pending = client.request("test.echo");
  const request = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "res",
    id: request.id,
    ok: true,
    body: { streamId: 45, length: 1 },
  }));
  const response = await pending;
  await new Promise((resolve) => setTimeout(resolve, 60));
  socket.receive(buildBinaryFrame(45, BINARY_FRAME_DATA, new Uint8Array([7])));
  await new Promise((resolve) => setTimeout(resolve, 60));
  socket.receive(buildBinaryFrame(45, BINARY_FRAME_END));

  assert.deepEqual(
    [...new Uint8Array(await new Response(response.body.stream).arrayBuffer())],
    [7],
  );
  client.close();
});

test("drops chunks for a cancelled response body", async () => {
  const { client, socket } = await connectedClient();
  const pending = client.call("fs.transfer.send", { path: "file.bin" });
  const request = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "res",
    id: request.id,
    ok: true,
    data: { ok: true },
    body: { streamId: 44, length: 3 },
  }));
  await assert.rejects(pending, /returned a body/);
  const cancellation = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(cancellation.streamId, 44);
  assert.equal(cancellation.flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
  socket.receive(buildBinaryFrame(44, BINARY_FRAME_DATA, new Uint8Array([1, 2, 3])));
  socket.receive(buildBinaryFrame(44, BINARY_FRAME_END));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const followup = client.request("test.echo");
  const followupRequest = JSON.parse(socket.sent.at(-1));
  socket.receive(JSON.stringify({
    type: "res",
    id: followupRequest.id,
    ok: true,
    data: { ok: true },
  }));
  assert.deepEqual((await followup).data, { ok: true });
  client.close();
});

test("cancels a body on a late response", async () => {
  const { client, socket } = await connectedClient();

  socket.receive(JSON.stringify({
    type: "res",
    id: "no-longer-pending",
    ok: true,
    body: { streamId: 46, length: 3 },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const cancellation = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(cancellation.streamId, 46);
  assert.equal(cancellation.flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
  client.close();
});

test("receiver cancellation stops the peer's shared outgoing body pump", async () => {
  const senderFrames = [];
  const receiverFrames = [];
  let sender;
  let receiver;
  let cancelled = false;
  sender = new BinaryBodyChannel({
    sendFrame(frame) {
      senderFrames.push(frame);
      receiver.handleFrame(frame);
    },
  });
  receiver = new BinaryBodyChannel({
    sendFrame(frame) {
      receiverFrames.push(frame);
      sender.handleFrame(frame);
    },
  });
  const outgoing = sender.prepare({
    stream: new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    }),
  });
  const incoming = receiver.receive(outgoing.descriptor);
  const sending = outgoing.send();

  await incoming.stream.cancel("response no longer needed");
  await sending;

  assert.equal(cancelled, true);
  assert.equal(senderFrames.length, 0);
  const terminal = parseBinaryFrame(receiverFrames.at(-1));
  assert.equal(terminal.streamId, outgoing.descriptor.streamId);
  assert.equal(terminal.flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
});

test("prepared body cancellation still terminates the announced stream", async () => {
  const frames = [];
  const channel = new BinaryBodyChannel({ sendFrame: (frame) => frames.push(frame) });
  const outgoing = channel.prepare(bodyFromBytes(new Uint8Array([1])));

  await outgoing.cancel("response rejected before send");

  const terminal = parseBinaryFrame(frames[0]);
  assert.equal(terminal.streamId, outgoing.descriptor.streamId);
  assert.equal(terminal.flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
});

test("does not miss aborts while registering an outgoing body signal", async () => {
  const frames = [];
  let sourceCancelled = false;
  let aborted = false;
  const reason = new Error("abort during registration");
  const signal = {
    get aborted() {
      return aborted;
    },
    reason,
    addEventListener(_type, listener) {
      aborted = true;
      listener();
    },
    removeEventListener() {},
  };
  const channel = new BinaryBodyChannel({ sendFrame: (frame) => frames.push(frame) });
  const outgoing = channel.prepare({
    stream: new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => {
        sourceCancelled = true;
      },
    }),
  });

  await outgoing.send(signal);

  assert.equal(sourceCancelled, true);
  const terminal = parseBinaryFrame(frames[0]);
  assert.equal(terminal.streamId, outgoing.descriptor.streamId);
  assert.equal(terminal.flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
});

test("sends an error frame when an outbound body is already locked", async () => {
  const { client, socket } = await connectedClient();
  const stream = body(new Uint8Array([1, 2, 3])).stream;
  const reader = stream.getReader();
  const pending = client.request("test.echo", {}, { body: { stream, length: 3 } });

  await assert.rejects(pending, /locked/i);
  const error = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(error.flags, 6);
  reader.releaseLock();
  client.close();
});

test("cancels an upload when the request completes early", async () => {
  const { client, socket } = await connectedClient();
  let cancelled = false;
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = client.request("test.echo", {}, { body: { stream } });
  const request = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({ type: "res", id: request.id, ok: true, data: {} }));
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cancelled, true);
  const terminal = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(terminal.streamId, request.body.streamId);
  assert.equal(terminal.flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
  client.close();
});

test("cancels an outbound request before rejecting its timeout", async () => {
  const client = new GSVClient({
    WebSocket: FakeWebSocket,
    defaultRequestTimeoutMs: 10,
  });
  await client.connect({
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;
  const pending = client.request("test.slow");
  const request = JSON.parse(socket.sent.at(-1));

  await assert.rejects(pending, /Request timed out after 10ms: test\.slow/);

  const cancellation = JSON.parse(socket.sent.at(-1));
  assert.deepEqual(cancellation, {
    type: "sig",
    signal: REQUEST_CANCEL_SIGNAL,
    payload: {
      id: request.id,
      reason: "Request timed out after 10ms: test.slow",
    },
  });
  client.close();
});

test("cancels an inbound driver request without publishing the reserved signal", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({ keepalive: false });
  let requestSignal;
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  driver.implement("shell.exec", async (_request, context) => {
    requestSignal = context.abortSignal;
    started();
    await new Promise((resolve) => context.abortSignal.addEventListener("abort", resolve, { once: true }));
    return { data: { status: "completed", output: "late", exitCode: 0 } };
  });
  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;
  const published = [];
  client.onSignal((signal) => published.push(signal));

  socket.receive(JSON.stringify({ type: "req", id: "inbound-1", call: "shell.exec", args: { input: "sleep 300" } }));
  await requestStarted;
  socket.receive(JSON.stringify({
    type: "sig",
    signal: REQUEST_CANCEL_SIGNAL,
    payload: { id: "inbound-1", reason: "User interrupted" },
  }));
  socket.receive(JSON.stringify({
    type: "sig",
    signal: REQUEST_CANCEL_SIGNAL,
    payload: { id: "inbound-1" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requestSignal.aborted, true);
  assert.match(requestSignal.reason.message, /User interrupted/);
  assert.deepEqual(published, []);
  assert.equal(socket.sent.some((data) => {
    if (typeof data !== "string") return false;
    const frame = JSON.parse(data);
    return frame.type === "res" && frame.id === "inbound-1";
  }), false);
  driver.close();
});

test("keeps driver acknowledgement checks opt-in", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({ keepalive: { intervalMs: 10 } });
  driver.implement("shell.exec", async () => ({ data: {} }));

  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const ping = JSON.parse(FakeWebSocket.instance.sent.at(-1));
  assert.equal(ping.signal, "device.ping");
  assert.equal(ping.payload.nonce, undefined);
  driver.close();
});

test("uses unacknowledged keepalives when the gateway does not advertise pong support", async () => {
  const client = new GSVClient({ WebSocket: LegacyGatewayWebSocket });
  const driver = client.driver({
    keepalive: {
      intervalMs: 10,
      acknowledgement: { timeoutMs: 20 },
    },
  });
  driver.implement("shell.exec", async () => ({ data: {} }));

  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const ping = JSON.parse(LegacyGatewayWebSocket.instance.sent.at(-1));
  assert.equal(ping.signal, "device.ping");
  assert.equal(ping.payload.nonce, undefined);
  assert.equal(client.getStatus().state, "connected");
  driver.close();
});

test("disconnects a driver when its keepalive acknowledgement is missing", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({
    keepalive: {
      intervalMs: 1_000,
      acknowledgement: { timeoutMs: 20 },
    },
  });
  driver.implement("shell.exec", async () => ({ data: {} }));
  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;
  const ping = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "sig",
    signal: "device.pong",
    payload: { nonce: `${ping.payload.nonce}-stale` },
  }));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(client.getStatus().state, "disconnected");
  assert.equal(client.getStatus().message, "device heartbeat timed out");
  driver.close();
});

test("disconnects a driver when an acknowledged keepalive cannot be sent", async () => {
  const client = new GSVClient({ WebSocket: SignalFailingWebSocket });
  const driver = client.driver({
    keepalive: { acknowledgement: {} },
  });
  driver.implement("shell.exec", async () => ({ data: {} }));

  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });

  assert.equal(client.getStatus().state, "disconnected");
  assert.equal(client.getStatus().message, "device heartbeat send failed");
  driver.close();
});

test("accepts only the matching driver keepalive acknowledgement", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({
    keepalive: {
      intervalMs: 1_000,
      acknowledgement: { timeoutMs: 20 },
    },
  });
  driver.implement("shell.exec", async () => ({ data: {} }));
  await driver.connect({
    deviceId: "test-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;
  const ping = JSON.parse(socket.sent.at(-1));

  socket.receive(JSON.stringify({
    type: "sig",
    signal: "device.pong",
    payload: { nonce: ping.payload.nonce, at: Date.now() },
  }));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(client.getStatus().state, "connected");
  driver.close();
});

test("cancelling an inbound request terminates its incoming body", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({ keepalive: false });
  let reading;
  const bodyReading = new Promise((resolve) => {
    reading = resolve;
  });
  driver.implement("shell.exec", async (request) => {
    reading();
    await new Response(request.body.stream).arrayBuffer();
    return { data: {} };
  });
  await driver.connect({
    deviceId: "body-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;

  socket.receive(JSON.stringify({
    type: "req",
    id: "inbound-body",
    call: "shell.exec",
    args: {},
    body: { streamId: 90, length: 3 },
  }));
  await bodyReading;
  socket.receive(JSON.stringify({
    type: "sig",
    signal: REQUEST_CANCEL_SIGNAL,
    payload: { id: "inbound-body", reason: "Stop upload" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const terminal = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(terminal.streamId, 90);
  assert.equal(terminal.flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
  assert.match(new TextDecoder().decode(terminal.payload), /Stop upload/);
  driver.close();
});

test("cancelling an inbound request stops its response body", async () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });
  const driver = client.driver({ keepalive: false });
  let sourceCancelled;
  const cancelled = new Promise((resolve) => {
    sourceCancelled = resolve;
  });
  driver.implement("shell.exec", async () => ({
    data: {},
    body: {
      stream: new ReadableStream({
        pull: () => new Promise(() => {}),
        cancel: sourceCancelled,
      }),
    },
  }));
  await driver.connect({
    deviceId: "response-driver",
    url: "ws://test",
    username: "test",
    password: "test",
  });
  const socket = FakeWebSocket.instance;

  socket.receive(JSON.stringify({ type: "req", id: "inbound-response", call: "shell.exec", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = socket.sent
    .filter((data) => typeof data === "string")
    .map((data) => JSON.parse(data))
    .find((frame) => frame.type === "res" && frame.id === "inbound-response");
  assert.ok(response?.body);

  socket.receive(JSON.stringify({
    type: "sig",
    signal: REQUEST_CANCEL_SIGNAL,
    payload: { id: "inbound-response" },
  }));
  await cancelled;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const terminal = parseBinaryFrame(socket.sent.at(-1));
  assert.equal(terminal.streamId, response.body.streamId);
  assert.equal(terminal.flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
  driver.close();
});
