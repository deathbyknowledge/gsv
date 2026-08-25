import assert from "node:assert/strict";
import { setTimeout as waitForTimer } from "node:timers/promises";
import test from "node:test";

import { connectionFailureReason, ReconnectSupervisor } from "../src/reconnect.mjs";

test("bounds connection errors and redacts credentials", () => {
  assert.equal(
    connectionFailureReason(new Error("token=top-secret\nrejected"), ["top-secret"]),
    "token=[redacted] rejected",
  );
});

test("serializes synchronous disconnect notifications during connection", async () => {
  let connected = false;
  let attempts = 0;
  let supervisor;
  supervisor = new ReconnectSupervisor({
    isConnected: () => connected,
    connect: async () => {
      attempts += 1;
      supervisor.disconnected();
      connected = true;
    },
  });

  await supervisor.start();
  await waitForTimer(5);
  assert.equal(attempts, 1);
  await supervisor.stop();
});

test("owns one retry loop and reconnects after a later disconnect", async () => {
  let connected = false;
  let attempts = 0;
  let supervisor;
  supervisor = new ReconnectSupervisor({
    isConnected: () => connected,
    connect: async () => {
      attempts += 1;
      supervisor.disconnected();
      if (attempts === 1) {
        throw new Error("first attempt failed");
      }
      connected = true;
    },
    wait: async () => {},
  });

  await supervisor.start();
  await waitForTimer(5);
  assert.equal(attempts, 2);

  connected = false;
  supervisor.disconnected();
  await waitForTimer(5);
  assert.equal(attempts, 3);
  await supervisor.stop();
});
