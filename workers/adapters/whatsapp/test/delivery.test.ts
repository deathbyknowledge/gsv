import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedWhatsAppPeerEnv } from "../src/managed-peer";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedWhatsAppPeerEnv & { WHATSAPP_API: Fetcher };
const stateKey = "managed_whatsapp_peer:v1:state";
type GraphMessage = { kind: string; body: { to?: string; type?: string; text?: { body?: string } } };

async function seed(actorId: string, closed = false) {
  const peer = bindings.MANAGED_WHATSAPP_PEER.getByName(`managed:${actorId}`);
  const route = {
    installationId: "installation_delivery", localUid: 1000, generation: "delivery-generation",
    canonicalOrigin: "https://delivery.gsv.test", linkedAt: Date.now(),
  };
  await runInDurableObject(peer, async (_instance, state) => {
    await state.storage.put(stateKey, {
      version: 1, actorId, surfaceId: actorId, activeRoute: route,
      lastInboundAt: Date.now() - (closed ? 25 * 60 * 60 * 1000 : 1_000),
    } satisfies ManagedWhatsAppPeerState);
  });
  const message = {
    deliveryId: `delivery-${actorId}`, routeGeneration: route.generation,
    surface: { kind: "dm" as const, id: actorId }, actorId, text: "A delivery receipt",
  };
  return { peer, route, message };
}

async function messages(actorId: string): Promise<GraphMessage[]> {
  const records = await (await bindings.WHATSAPP_API.fetch("https://graph.test/records")).json<GraphMessage[]>();
  return records.filter((record) => record.kind === "message" && record.body.to === actorId);
}

it.each([
  ["recordProgress", false, "34690201111", false],
  ["succeed", false, "34690202222", false],
  ["succeed", true, "34690203333", false],
  ["recordProgress", false, "34690205555", true],
  ["succeed", true, "34690206666", true],
] as const)("keeps an accepted send ambiguous when %s fails (template: %s, actor: %s, marker fails: %s)", async (method, closed, actorId, markerFails) => {
  const { peer, route, message } = await seed(actorId, closed);
  await runInDurableObject(peer, async (instance, state) => {
    // SAFETY: inject a storage failure at the instance's private ledger boundary.
    const ledger = instance["deliveries"];
    const failure = vi.spyOn(ledger, method).mockRejectedValueOnce(new Error("storage unavailable"));
    const markerFailure = markerFails ? vi.spyOn(ledger, "failAmbiguous").mockRejectedValueOnce(new Error("still unavailable")) : undefined;
    try {
      expect(await instance.sendMessage(route.installationId, message)).toMatchObject({ ok: false, ambiguous: true });
      expect(await state.storage.get(`outbound_delivery:v1:record:${message.deliveryId}`)).toMatchObject({ state: markerFails ? "attempting" : "ambiguous" });
    } finally {
      failure.mockRestore();
      markerFailure?.mockRestore();
    }
  });
  using repeated = await peer.sendMessage(route.installationId, message);
  expect(repeated).toMatchObject({ ok: false, ambiguous: true });
  expect(await messages(actorId)).toHaveLength(1);
});

it("does not template or hold an already partially sent delivery after the window closes", async () => {
  const actorId = "34690204444";
  const { peer, route, message } = await seed(actorId);
  const first = "a".repeat(400);
  const second = `throttle-second-part ${"b".repeat(400)}`;
  message.text = `${first}\n\n${second}`;
  await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: "throttle-second-part" });
  try {
    using initial = await peer.sendMessage(route.installationId, message);
    expect(initial).toMatchObject({ ok: false, retryable: true });
  } finally {
    await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: "" });
  }
  expect((await messages(actorId)).map((record) => record.body.text?.body)).toEqual([first]);
  await runInDurableObject(peer, async (_instance, state) => {
    const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
    await state.storage.put(stateKey, { ...current, lastInboundAt: Date.now() - 25 * 60 * 60 * 1000 });
  });
  using retried = await peer.sendMessage(route.installationId, message);
  expect(retried).toMatchObject({ ok: false, error: expect.stringContaining("window is closed") });
  expect(await messages(actorId)).toHaveLength(1);
  await runInDurableObject(peer, async (_instance, state) => {
    expect((await state.storage.list({ prefix: "managed_whatsapp_peer:v1:held:" })).size).toBe(0);
    expect((await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!.pendingTemplate).toBeUndefined();
  });
});
