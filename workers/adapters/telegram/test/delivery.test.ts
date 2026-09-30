import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedTelegramPeerEnv } from "../src/managed-peer";
import type { ManagedTelegramPeerState } from "../src/managed-peer-state";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedTelegramPeerEnv & { TELEGRAM_API: Fetcher };

async function seed(actorId: string) {
  const peer = bindings.MANAGED_TELEGRAM_PEER.getByName(`managed:${actorId}`);
  const route = {
    installationId: "installation_delivery", localUid: 1000, generation: "delivery-generation",
    canonicalOrigin: "https://delivery.gsv.test", linkedAt: Date.now(),
  };
  const message = {
    deliveryId: `delivery-${actorId}`, routeGeneration: route.generation,
    surface: { kind: "dm" as const, id: actorId }, actorId, text: "A delivery receipt",
  };
  await runInDurableObject(peer, async (_instance, state) => {
    await state.storage.put("managed_telegram_peer:v1:state", { version: 1, actorId, surfaceId: actorId, activeRoute: route });
  });
  return { peer, route, message };
}

async function sentTexts(actorId: string): Promise<string[]> {
  const records = await (await bindings.TELEGRAM_API.fetch("https://telegram-api.test/messages")).json<Array<{ body: { chat_id?: string; text?: string } }>>();
  return records.filter((record) => String(record.body.chat_id) === actorId && record.body.text !== undefined).map((record) => record.body.text!);
}

it.each([
  ["recordProgress", "22345", false],
  ["succeed", "32345", false],
  ["recordProgress", "42345", true],
] as const)("keeps an accepted send ambiguous when %s fails (actor: %s, marker fails: %s)", async (method, actorId, markerFails) => {
  const { peer, route, message } = await seed(actorId);
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
  expect(await sentTexts(actorId)).toEqual([message.text]);
});

it("retries an unsent suffix after a local failure before the next provider call", async () => {
  const actorId = "52345";
  const { peer, route, message } = await seed(actorId);
  const first = "a".repeat(400);
  const second = `__rate_limit_once__ ${"b".repeat(400)}`;
  message.text = `${first}\n\n${second}`;
  using initial = await peer.sendMessage(route.installationId, message);
  expect(initial).toMatchObject({ ok: false, retryable: true });
  expect(await sentTexts(actorId)).toEqual([first]);
  await runInDurableObject(peer, async (instance, state) => {
    const read = instance["requireState"];
    instance["requireState"] = async () => {
      const receipt = await state.storage.get<{ state: string }>(`outbound_delivery:v1:record:${message.deliveryId}`);
      if (receipt?.state === "attempting") throw new Error("state read temporarily unavailable");
      return await read.call(instance);
    };
    try {
      expect(await instance.sendMessage(route.installationId, message)).toMatchObject({ ok: false, retryable: true });
      expect(await state.storage.get(`outbound_delivery:v1:record:${message.deliveryId}`)).toMatchObject({ state: "retryable", progress: { sent: 1 } });
    } finally {
      instance["requireState"] = read;
    }
  });
  expect(await sentTexts(actorId)).toEqual([first]);
  using retried = await peer.sendMessage(route.installationId, message);
  expect(retried).toMatchObject({ ok: true });
  expect(await sentTexts(actorId)).toEqual([first, second]);
});

it("does not replay when response handling throws after a provider request", async () => {
  const actorId = "62345";
  const { peer, route, message } = await seed(actorId);
  message.text = "__missing_send_result__";
  using initial = await peer.sendMessage(route.installationId, message);
  expect(initial).toMatchObject({ ok: false, ambiguous: true });
  using repeated = await peer.sendMessage(route.installationId, message);
  expect(repeated).toMatchObject({ ok: false, ambiguous: true });
  expect(await sentTexts(actorId)).toEqual([message.text]);
});

it("does not send the next part when the route changes during the pacing pause", async () => {
  const actorId = "72345";
  const { peer, route, message } = await seed(actorId);
  const first = "a".repeat(400);
  message.text = `${first}\n\n${"b".repeat(400)}`;
  await runInDurableObject(peer, async (instance, state) => {
    const pause = instance["pauseBetweenParts"];
    instance["pauseBetweenParts"] = async () => {
      const current = (await state.storage.get<ManagedTelegramPeerState>("managed_telegram_peer:v1:state"))!;
      await state.storage.put("managed_telegram_peer:v1:state", { ...current, activeRoute: { ...route, generation: "new-generation" } });
    };
    try {
      expect(await instance.sendMessage(route.installationId, message)).toMatchObject({
        ok: false, error: "Telegram delivery failed (permanent)",
      });
    } finally {
      instance["pauseBetweenParts"] = pause;
    }
  });
  expect(await sentTexts(actorId)).toEqual([first]);
});
