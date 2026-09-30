import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedTelegramPeerEnv } from "../src/managed-peer";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedTelegramPeerEnv & { TELEGRAM_API: Fetcher };

it.each([
  ["recordProgress", "22345", false],
  ["succeed", "32345", false],
  ["recordProgress", "42345", true],
] as const)("keeps an accepted send ambiguous when %s fails (actor: %s, marker fails: %s)", async (method, actorId, markerFails) => {
  const peer = bindings.MANAGED_TELEGRAM_PEER.getByName(`managed:${actorId}`);
  const route = {
    installationId: "installation_delivery", localUid: 1000, generation: "delivery-generation",
    canonicalOrigin: "https://delivery.gsv.test", linkedAt: Date.now(),
  };
  const message = {
    deliveryId: `delivery-${actorId}`, routeGeneration: route.generation,
    surface: { kind: "dm" as const, id: actorId }, actorId, text: "A delivery receipt",
  };
  await runInDurableObject(peer, async (instance, state) => {
    await state.storage.put("managed_telegram_peer:v1:state", { version: 1, actorId, surfaceId: actorId, activeRoute: route });
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
  const records = await (await bindings.TELEGRAM_API.fetch("https://telegram-api.test/messages")).json<Array<{ body: { chat_id?: string; text?: string } }>>();
  expect(records.filter((record) => String(record.body.chat_id) === actorId && record.body.text === message.text)).toHaveLength(1);
});
