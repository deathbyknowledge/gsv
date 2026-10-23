import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedWhatsAppPeerEnv } from "../src/managed-peer";
import { retireWhatsAppOutbox } from "../src/whatsapp-upgrade";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";
import type { ManagedWhatsAppInbound } from "../src/whatsapp-webhook";
import {
  attachWhatsAppApprovalMessage,
  describeWhatsAppApproval,
  prepareWhatsAppApproval,
} from "../src/whatsapp-approval";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedWhatsAppPeerEnv & { WHATSAPP_API: Fetcher };
const stateKey = "managed_whatsapp_peer:v1:state";
type GraphMessage = { kind: string; body: { to?: string; type?: string; text?: { body?: string } } };
type GatewayCall = {
  call: string;
  args: { pid?: string; requestId?: string; decision?: string; remember?: boolean; message?: { messageId?: string } };
};

async function seed(actorId: string) {
  const peer = bindings.MANAGED_WHATSAPP_PEER.getByName(`managed:${actorId}`);
  const route = {
    installationId: "installation_recovery", localUid: 1000, generation: "revoked-generation",
    canonicalOrigin: "https://recovery.gsv.test", linkedAt: Date.now(),
  };
  await runInDurableObject(peer, async (_instance, state) => {
    await state.storage.put(stateKey, { version: 1, actorId, surfaceId: actorId, activeRoute: route });
  });
  return { peer, route };
}

function incoming(actorId: string, messageId: string, text: string, timestamp = Date.now()): ManagedWhatsAppInbound {
  return { actorId, surfaceId: actorId, deliveryId: messageId, messageId, text, timestamp, unsupportedContent: false };
}

async function messages(actorId: string): Promise<GraphMessage[]> {
  const records = await (await bindings.WHATSAPP_API.fetch("https://graph.test/records")).json<GraphMessage[]>();
  return records.filter((record) => record.kind === "message" && record.body.to === actorId);
}

async function gatewayCalls(): Promise<GatewayCall[]> {
  return await (await bindings.GATEWAY.fetch("https://gateway.test/calls")).json<GatewayCall[]>();
}

function approvalState(storage: DurableObjectStorage, token: string) {
  return storage.sql.exec<{ state: string; resolution: string | null; decision: string | null; remember: number | null }>(
    `SELECT state, json_extract(record_json, '$.resolution') AS resolution,
       json_extract(record_json, '$.selection.decision') AS decision,
       json_extract(record_json, '$.selection.remember') AS remember
     FROM adapter_hil_approvals WHERE provider = 'whatsapp' AND token = ?`,
    token,
  ).one();
}

it.each([404, 503])("unblocks text after an obsolete approval, starting with error %i", async (initialCode) => {
  const actorId = initialCode === 404 ? "34690104444" : "34690105555";
  const { peer, route } = await seed(actorId);
  const requestId = `obsolete-approval-${initialCode}`;
  const controls = await runInDurableObject(peer, async (_instance, state) => {
    const request = {
      pid: "proc-deleted", requestId, runId: "run-deleted", callId: "call-deleted",
      toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "date" }, createdAt: Date.now(),
    };
    const context = {
      deliveryId: requestId, accountId: "managed", actorId, surface: { kind: "dm" as const, id: actorId },
      routeGeneration: route.generation, processId: request.pid, runId: request.runId, processMode: "ship" as const,
      hil: request,
    };
    const prepared = await prepareWhatsAppApproval(state.storage, describeWhatsAppApproval(context, request), route);
    if (!prepared) throw new Error("Fixture approval must have reply buttons");
    await attachWhatsAppApprovalMessage(state.storage, prepared.token, `wamid.prompt.${initialCode}`);
    return prepared;
  });
  const reply = {
    interactionId: `wamid.obsolete.${initialCode}`, actorId, surfaceId: actorId,
    providerMessageId: `wamid.prompt.${initialCode}`, data: controls.buttons[1]!.id,
  };
  const approvalReceipt = `managed_whatsapp_peer:v1:inbound:interactive:${reply.interactionId}`;
  const followup = incoming(actorId, `wamid.after.obsolete.${initialCode}`, "hello after obsolete approval");

  await peer.handleWebhook({ kind: "approval", reply });
  await peer.handleWebhook({ kind: "message", inbound: followup });
  await runInDurableObject(peer, async (instance) => { await instance.alarm(); });

  if (initialCode === 503) {
    const failedAttempts = (await gatewayCalls()).filter((call) => call.args.requestId === requestId).length;
    expect(failedAttempts).toBeGreaterThan(0);
    expect((await gatewayCalls()).some((call) => call.args.message?.messageId === followup.messageId)).toBe(false);
    expect(await messages(actorId)).toEqual([]);
    await runInDurableObject(peer, async (instance, state) => {
      expect(await state.storage.get(approvalReceipt)).toMatchObject({ state: "provider" });
      expect(approvalState(state.storage, controls.token)).toEqual({
        state: "pending", resolution: null, decision: "approve", remember: 1,
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm();
    });
    expect((await gatewayCalls()).filter((call) => call.args.requestId === requestId).length).toBeGreaterThan(failedAttempts);
    await bindings.GATEWAY.fetch("https://gateway.test/recover-obsolete-approval");
    await runInDurableObject(peer, async (instance) => { await instance.alarm(); });
  }

  await vi.waitFor(async () => {
    const text = (await messages(actorId)).map((message) => message.body.text?.body);
    expect(text.some((value) => value?.includes("This approval is no longer pending."))).toBe(true);
    expect(text).toContain("Personal received hello after obsolete approval");
    expect(text.some((value) => value?.includes("Approved"))).toBe(false);
  });
  await runInDurableObject(peer, async (_instance, state) => {
    expect(await state.storage.get(approvalReceipt)).toMatchObject({ state: "completed" });
    expect(await state.storage.get(`managed_whatsapp_peer:v1:inbound:${followup.deliveryId}`)).toMatchObject({ state: "completed" });
    expect(approvalState(state.storage, controls.token)).toEqual({
      state: "resolved", resolution: "stale", decision: "approve", remember: 1,
    });
  });
  const approvalCalls = (await gatewayCalls()).filter((call) => call.args.requestId === requestId);
  expect(approvalCalls.length).toBeGreaterThan(0);
  expect(approvalCalls.every((call) => call.call === "proc.hil" && call.args.pid === "proc-deleted"
    && call.args.decision === "approve" && call.args.remember === true)).toBe(true);
  expect((await gatewayCalls()).filter((call) => call.args.message?.messageId === followup.messageId)).toHaveLength(1);

  await peer.handleWebhook({ kind: "approval", reply: { ...reply, interactionId: `wamid.obsolete.again.${initialCode}` } });
  await runInDurableObject(peer, async (instance) => { await instance.alarm(); });
  expect((await gatewayCalls()).filter((call) => call.args.requestId === requestId)).toHaveLength(approvalCalls.length);
});

it("offers pairing after revocation and changes the route only after confirmation", async () => {
  const actorId = "34690101111";
  const { peer, route } = await seed(actorId);
  await peer.handleWebhook({ kind: "message", inbound: incoming(actorId, "wamid.recovery", "__identity_revoked__") });
  let code = "";
  await vi.waitFor(async () => {
    const text = (await messages(actorId)).find((message) => /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/.test(message.body.text?.body ?? ""))?.body.text?.body ?? "";
    code = text.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0]?.replaceAll("-", "") ?? "";
    expect(code).toHaveLength(12);
  });
  await runInDurableObject(peer, async (_instance, state) => {
    expect(await state.storage.get(stateKey)).toMatchObject({ activeRoute: route });
  });
  const pairing = bindings.MANAGED_WHATSAPP_PAIRING.getByName(`pair:${code}`);
  using candidate = await pairing.inspect();
  expect(candidate).toMatchObject({ actorId, linked: true });
  const operation = {
    code, installationId: route.installationId, localUid: route.localUid,
    operationId: "confirm-after-recovery", canonicalOrigin: route.canonicalOrigin,
  };
  using prepared = await pairing.prepare(operation);
  expect(prepared.route.generation).not.toBe(route.generation);
  const activation = { code, operationId: operation.operationId, route: prepared.route, canonicalOrigin: route.canonicalOrigin };
  using activated = await pairing.activate(activation);
  using finalized = await pairing.finalize(activation);
  expect(activated.route.generation).toBe(prepared.route.generation);
  expect(finalized.route.generation).toBe(prepared.route.generation);
  await peer.handleWebhook({ kind: "message", inbound: incoming(actorId, "wamid.recovered", "hello after reconnecting") });
  await vi.waitFor(async () => {
    expect(await messages(actorId)).toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ text: expect.objectContaining({ body: "Personal received hello after reconnecting" }) }),
    }));
  });
});

it("does not issue pairing from a revoked result belonging to a replaced route", async () => {
  const actorId = "34690102222";
  const { peer, route } = await seed(actorId);
  const inbound = incoming(actorId, "wamid.recovery.delayed", "__identity_revoked_delayed__");
  await peer.handleWebhook({ kind: "message", inbound });
  try {
    await vi.waitFor(async () => {
      const calls = await (await bindings.GATEWAY.fetch("https://gateway.test/calls")).json<Array<{ args?: { message?: { messageId?: string } } }>>();
      expect(calls.some((call) => call.args?.message?.messageId === inbound.messageId)).toBe(true);
    });
    await runInDurableObject(peer, async (_instance, state) => {
      const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
      await state.storage.put(stateKey, { ...current, activeRoute: { ...route, generation: "new-generation" } });
    });
  } finally {
    await bindings.GATEWAY.fetch("https://gateway.test/release-recovery");
  }
  await vi.waitFor(async () => {
    await runInDurableObject(peer, async (_instance, state) => {
      expect(await state.storage.get(`managed_whatsapp_peer:v1:inbound:${inbound.deliveryId}`)).toMatchObject({ state: "completed" });
      expect(await state.storage.get(stateKey)).toMatchObject({ activeRoute: { generation: "new-generation" } });
      expect((await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!.pairing).toBeUndefined();
    });
  });
  expect(await messages(actorId)).toEqual([]);
});

it("retires legacy copies and replay receipts without sending or blocking a new reply", async () => {
  const actorId = "34690103333";
  const { peer, route } = await seed(actorId);
  await runInDurableObject(peer, async (instance, state) => {
    const original = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
    await state.storage.put(stateKey, { ...original, pendingTemplate: { sentAt: 1, expiresAt: Date.now() + 10000 } });
    await state.storage.put("managed_whatsapp_peer:v1:held:old", {
      version: 1, owner: route, deliveryId: "old", markdown: "Old delivery copy",
    });
    await instance["inboundDeliveries"].enqueueAndArm("old-replay", { kind: "release-held", routeGeneration: route.generation }, Date.now() + 10000, route);
    await retireWhatsAppOutbox(state.storage);
    await retireWhatsAppOutbox(state.storage);
    expect(await state.storage.get(stateKey)).toEqual(original);
    expect((await state.storage.list({ prefix: "managed_whatsapp_peer:v1:held:" })).size).toBe(0);
    const inspected = await instance.inspectInstallationResource(route.installationId);
    expect(inspected).toMatchObject({ outcome: "identified", installationId: route.installationId });
    await instance.alarm();
    expect(await state.storage.get("managed_whatsapp_peer:v1:inbound:old-replay")).toMatchObject({ state: "completed" });
  });
  expect(await messages(actorId)).toEqual([]);
  await peer.handleWebhook({ kind: "message", inbound: incoming(actorId, "wamid.after.upgrade", "hello after upgrade") });
  await vi.waitFor(async () => {
    expect((await messages(actorId)).map((message) => message.body.text?.body)).toEqual(["Personal received hello after upgrade"]);
  });
});
