import assert from "node:assert/strict";
import test from "node:test";
import { GSVClient } from "../dist/client.js";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "../dist/protocol/binary-frame.js";

class FakeWebSocket extends EventTarget {
  static instance;

  binaryType = "blob";
  readyState = 0;
  sent = [];

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
        },
      })));
    }
  }

  close() {
    this.readyState = 3;
  }

  receive(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
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

test("keeps body-bearing syscalls off the data-only namespaces", () => {
  const client = new GSVClient({ WebSocket: FakeWebSocket });

  assert.equal(client.fs.transfer.send, undefined);
  assert.equal(client.fs.transfer.receive, undefined);
  assert.equal(typeof client.fs.transfer.stat, "function");
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
  client.close();
});
