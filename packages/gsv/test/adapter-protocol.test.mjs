import assert from "node:assert/strict";
import test from "node:test";

import {
  isAdapterAccountStatus,
  isAdapterConnectChallenge,
  isAdapterInboundResult,
  isAdapterWorkerActivityResult,
  isAdapterWorkerConnectResult,
  isAdapterWorkerDisconnectResult,
  isAdapterWorkerSendResult,
  isAdapterWorkerStatusResult,
} from "../dist/protocol/adapters.js";
import { isAdapterConnectResult } from "../dist/protocol/syscalls/adapter.js";

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

test("round-trips QR connect challenges with rendering and expiry metadata", () => {
  const challenge = {
    type: "qr",
    message: "Scan in Linked Devices",
    data: "provider-secret-qr-payload",
    format: "raw",
    expiresAt: 1_800_000_000_000,
    extra: { refreshAfter: 30_000 },
  };
  const roundTripped = JSON.parse(JSON.stringify(challenge));

  assert.equal(isAdapterConnectChallenge(roundTripped), true);
  assert.deepEqual(roundTripped, challenge);
});

test("rejects unsafe or incomplete connect challenge shapes", () => {
  assert.equal(isAdapterConnectChallenge({ type: "qr", format: "raw" }), false);
  assert.equal(isAdapterConnectChallenge({ type: "qr", data: "value", format: "html" }), false);
  assert.equal(isAdapterConnectChallenge({ type: "qr", data: "value", expiresAt: Number.NaN }), false);
  assert.equal(isAdapterConnectChallenge({ type: "oauth", extra: [] }), false);
});

test("validates complete adapter connect results without exposing challenge data", () => {
  assert.equal(isAdapterConnectResult({
    ok: true,
    adapter: "whatsapp",
    accountId: "default",
    connected: false,
    authenticated: false,
    challenge: { type: "qr", data: "secret", format: "raw" },
  }), true);
  assert.equal(isAdapterConnectResult({
    ok: true,
    adapter: "whatsapp",
    accountId: "legacy",
    connected: false,
    authenticated: false,
    challenge: { type: "qr", data: "legacy-secret" },
  }), true);
  assert.equal(isAdapterConnectResult({
    ok: true,
    adapter: "whatsapp",
    accountId: "default",
    challenge: { type: "qr", data: "secret" },
  }), false);
  assert.equal(isAdapterConnectResult({ ok: false, error: "worker unavailable" }), true);
});

test("validates private adapter worker connect results at the gateway boundary", () => {
  assert.equal(isAdapterWorkerConnectResult({
    ok: true,
    connected: false,
    authenticated: false,
    challenge: { type: "qr", data: "secret", format: "raw" },
  }), true);
  assert.equal(isAdapterWorkerConnectResult({
    ok: true,
    message: "Connected",
    connected: true,
    authenticated: true,
  }), true);
  assert.equal(isAdapterWorkerConnectResult({ ok: true, message: "Connected" }), false);
  assert.equal(isAdapterWorkerConnectResult({ ok: false, error: "bad credentials" }), true);
  assert.equal(isAdapterWorkerConnectResult({ ok: false, error: "" }), false);
  assert.equal(isAdapterWorkerConnectResult({
    ok: true,
    challenge: { type: "qr", format: "raw" },
  }), false);
  assert.equal(isAdapterWorkerConnectResult({ ok: true, connected: "yes" }), false);
});

test("validates every private adapter worker RPC result", () => {
  assert.equal(isAdapterWorkerDisconnectResult({ ok: true, message: "Disconnected" }), true);
  assert.equal(isAdapterWorkerDisconnectResult({ ok: false, error: "" }), false);

  assert.equal(isAdapterWorkerSendResult({
    ok: true,
    messageId: "provider-1",
    deduplicated: false,
  }), true);
  assert.equal(isAdapterWorkerSendResult({
    ok: false,
    error: "unknown outcome",
    ambiguous: true,
  }), true);
  assert.equal(isAdapterWorkerSendResult({
    ok: false,
    error: "unknown outcome",
    ambiguous: "yes",
  }), false);
  assert.equal(isAdapterWorkerSendResult({
    ok: false,
    error: "contradictory outcome",
    retryable: true,
    ambiguous: true,
  }), false);

  assert.equal(isAdapterWorkerActivityResult({ ok: true }), true);
  assert.equal(isAdapterWorkerActivityResult({ ok: false, error: "" }), false);

  const status = {
    accountId: "default",
    connected: true,
    authenticated: true,
    mode: "websocket",
    lastActivity: 123,
    extra: { selfE164: "+15555550123" },
  };
  assert.equal(isAdapterAccountStatus(status), true);
  assert.equal(isAdapterWorkerStatusResult([status]), true);
  assert.equal(isAdapterWorkerStatusResult([{ ...status, authenticated: "yes" }]), false);
  assert.equal(isAdapterWorkerStatusResult([{ ...status, accountId: " default " }]), false);
  assert.equal(isAdapterWorkerStatusResult({ accounts: [status] }), false);
});
