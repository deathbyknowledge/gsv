import assert from "node:assert/strict";
import test from "node:test";
import { connectHost } from "../dist/sdk/host.js";

test("transfers backend ArrayBuffers across the host MessagePort", async () => {
  const channel = new MessageChannel();
  const windowListeners = new Set();
  const parent = {
    postMessage(message) {
      queueMicrotask(() => {
        for (const listener of windowListeners) {
          listener({
            source: parent,
            data: { type: "gsv-host-connect", requestId: message.requestId },
            ports: [channel.port2],
          });
        }
      });
    },
  };
  globalThis.window = {
    parent,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener(type, listener) {
      if (type === "message") windowListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") windowListeners.delete(listener);
    },
  };

  let outbound;
  channel.port1.onmessage = (event) => {
    const message = event.data;
    if (message.method === "backend.send") {
      outbound = message.payload.data;
    }
    channel.port1.postMessage({
      type: "rpc-result",
      id: message.id,
      ok: true,
      data: message.method === "backend.connect" ? { connectionId: "backend-1" } : { ok: true },
    });
  };
  channel.port1.start();

  try {
    const client = await connectHost();
    const socket = await client.connectBackendSocket({});
    const sent = new Uint8Array([1, 2, 3]).buffer;

    await socket.send(sent);

    assert.equal(sent.byteLength, 0);
    assert.deepEqual([...new Uint8Array(outbound)], [1, 2, 3]);

    const received = new Promise((resolve) => socket.addEventListener("message", resolve));
    const incoming = new Uint8Array([4, 5, 6]).buffer;
    channel.port1.postMessage({
      type: "backend-message",
      connectionId: "backend-1",
      data: incoming,
    }, [incoming]);

    assert.equal(incoming.byteLength, 0);
    assert.deepEqual([...new Uint8Array(await received)], [4, 5, 6]);
  } finally {
    channel.port1.close();
    channel.port2.close();
    delete globalThis.window;
  }
});
