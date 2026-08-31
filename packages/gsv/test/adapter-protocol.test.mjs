import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterPeerSignalFrameSchema,
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
import {
  adapterServiceDescriptorSchema,
  adapterTargetCancelResultSchema,
  adapterTargetDescriptorListSchema,
  adapterTargetIdentitySchema,
  adapterTargetResponseFrameSchema,
} from "../dist/services/adapters.js";

test("validates an open-ended adapter service descriptor", () => {
  const descriptor = {
    version: 1,
    id: "matrix",
    displayName: "Matrix",
    capabilities: {
      connect: true,
      disconnect: true,
      send: true,
      status: true,
      activity: false,
      pairing: false,
      surfaces: ["dm", "group"],
      media: { inbound: ["image"], outbound: ["image", "document"] },
    },
  };

  assert.equal(adapterServiceDescriptorSchema.safeParse(descriptor).success, true);
  assert.equal(adapterServiceDescriptorSchema.safeParse({
    ...descriptor,
    capabilities: { ...descriptor.capabilities, deliveryFrames: true, targets: true },
  }).success, true);
  assert.equal(adapterServiceDescriptorSchema.safeParse({
    ...descriptor,
    id: "Matrix Plugin",
  }).success, false);
});

test("validates exact adapter delivery signals", () => {
  const hil = {
    type: "sig",
    signal: "proc.run.hil.requested",
    payload: {
      pid: "proc-1",
      requestId: "hil-1",
      runId: "run-1",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: "date" },
      createdAt: 1,
    },
  };
  assert.equal(adapterPeerSignalFrameSchema.safeParse(hil).success, true);
  assert.equal(adapterPeerSignalFrameSchema.safeParse({
    ...hil,
    payload: { ...hil.payload, requestId: undefined },
  }).success, false);

  const committed = {
    type: "sig",
    signal: "message.committed",
    payload: {
      directed: true,
      message: {
        id: "message-1",
        conversationId: "conversation-1",
        sequence: 1,
        author: { kind: "process", pid: "proc-1", uid: 1000 },
        text: "Done",
        origin: { kind: "process", pid: "proc-1", runId: "run-1" },
        processId: "proc-1",
        runId: "run-1",
        createdAt: 1,
      },
    },
  };
  assert.equal(adapterPeerSignalFrameSchema.safeParse(committed).success, true);
  assert.equal(adapterPeerSignalFrameSchema.safeParse({
    ...committed,
    payload: { ...committed.payload, directed: false },
  }).success, false);
});

test("validates adapter target discovery and response frames", () => {
  assert.equal(adapterTargetIdentitySchema.safeParse({
    accountId: "workspace-1",
    actorId: "user-1",
    routeGeneration: "route-1",
  }).success, true);
  assert.equal(adapterTargetDescriptorListSchema.safeParse([{
    id: "workspace",
    label: "Slack — Acme",
    description: "Slack workspace",
    platform: "slack",
    version: "web-api",
    implements: ["shell.exec"],
  }]).success, true);
  assert.equal(adapterTargetDescriptorListSchema.safeParse([{
    id: "Workspace 1",
    label: "Slack",
    description: "",
    platform: "slack",
    version: "",
    implements: ["shell.exec"],
  }]).success, false);
  assert.equal(adapterTargetResponseFrameSchema.safeParse({
    type: "res",
    id: "request-1",
    ok: true,
    data: { status: "completed", output: "ok\n", exitCode: 0 },
  }).success, true);
  assert.equal(adapterTargetResponseFrameSchema.safeParse({
    type: "res",
    id: "request-1",
    ok: false,
    error: { code: 502, message: "" },
  }).success, false);
  assert.equal(adapterTargetCancelResultSchema.safeParse({ cancelled: true }).success, true);
});

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
