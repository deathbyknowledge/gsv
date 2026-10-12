import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedWhatsAppPeerEnv } from "../src/managed-peer";
import { retireWhatsAppOutbox } from "../src/whatsapp-upgrade";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";
import type { ManagedWhatsAppInbound } from "../src/whatsapp-webhook";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedWhatsAppPeerEnv & { WHATSAPP_API: Fetcher };
const stateKey = "managed_whatsapp_peer:v1:state";
type GraphMessage = { kind: string; body: { to?: string; type?: string; text?: { body?: string } } };

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
