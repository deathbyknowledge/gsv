import assert from "node:assert/strict";
import test from "node:test";

import { isAdapterInboundResult } from "../dist/protocol/adapters.js";

test("validates adapter inbound results at the shared protocol boundary", () => {
  assert.equal(isAdapterInboundResult({
    ok: true,
    delivered: {
      uid: 1000,
      pid: "init:1000",
      runId: "run-1",
      queued: false,
    },
    reply: {
      deliveryId: "reply-1",
      text: "Done",
    },
  }), true);
  assert.equal(isAdapterInboundResult({
    ok: true,
    replayed: "completed",
  }), true);
});

test("rejects malformed adapter inbound results", () => {
  assert.equal(isAdapterInboundResult({ ok: true, replayed: "later" }), false);
  assert.equal(isAdapterInboundResult({
    ok: true,
    delivered: { uid: 1000, pid: "init:1000", runId: "run-1" },
  }), false);
  assert.equal(isAdapterInboundResult({
    ok: true,
    reply: { text: "missing delivery id" },
  }), false);
});
