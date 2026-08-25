import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { IpcServer } from "../src/ipc.mjs";

function nextLine(socket) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        resolve(buffered.slice(0, newline));
      }
    });
    socket.once("error", reject);
  });
}

test("serves bounded local actions and snapshots over a private Unix socket", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gsv-hdzero-ipc-test-"));
  const socketPath = path.join(directory, "bridge.sock");
  const actions = [];
  let actionReceived;
  const received = new Promise((resolve) => {
    actionReceived = resolve;
  });
  const server = new IpcServer(socketPath, {
    getSnapshot: () => ({
      type: "wearable.snapshot",
      clientConnection: "online",
      driverConnection: "offline",
      phase: "idle",
    }),
    onAction: async (action) => {
      actions.push(action);
      actionReceived();
    },
  });
  let socket;
  try {
    await server.start();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    socket = net.createConnection(socketPath);
    const first = JSON.parse(await nextLine(socket));
    assert.equal(first.clientConnection, "online");

    socket.write("not-json\n");
    socket.write('{"type":"unknown"}\n');
    socket.write('{"type":"ptt.toggle"}\n');
    socket.write('{"type":"view.open","view":"invalid"}\n');
    socket.write('{"type":"voice.toggle"}\n');
    await received;
    assert.deepEqual(actions, [{ type: "voice.toggle" }]);

    server.broadcast({
      type: "wearable.snapshot",
      clientConnection: "online",
      driverConnection: "online",
      phase: "recording",
    });
    const update = JSON.parse(await nextLine(socket));
    assert.equal(update.phase, "recording");
  } finally {
    socket?.destroy();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
