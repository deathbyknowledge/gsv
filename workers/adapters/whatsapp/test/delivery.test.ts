import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { DeliveryLedger, fingerprintOutboundDelivery } from "../../shared/src/delivery-ledger";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import type { ManagedWhatsAppPeerEnv } from "../src/managed-peer";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";
import { whatsAppDeliveryToken, type ManagedWhatsAppPeerEvent } from "../src/whatsapp-webhook";

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

it.each([undefined, 0, 1])("resumes the original paragraph partition after an update (format: %s)", async (formatVersion) => {
  const actorId = `3469021111${formatVersion ?? 2}`;
  const { peer, route, message } = await seed(actorId);
  const paragraphs = ["a".repeat(200), "b".repeat(200), "c".repeat(200)];
  message.text = paragraphs.join("\n\n");
  await runInDurableObject(peer, async (_instance, state) => {
    const ledger = new DeliveryLedger(state.storage);
    const claim = await ledger.claim(message.deliveryId, await fingerprintOutboundDelivery(message));
    if (!claim.claimed) throw new Error("Expected a fresh receipt");
    await ledger.recordProgress(message.deliveryId, claim.attemptId, { sent: 1, messageId: "accepted-prefix", formatVersion });
    await ledger.releaseRetryable(message.deliveryId, claim.attemptId);
  });
  using result = await peer.sendMessage(route.installationId, message);
  expect(result).toMatchObject({ ok: true, messageId: "accepted-prefix" });
  expect((await messages(actorId)).map((record) => record.body.text?.body)).toEqual(paragraphs.slice(formatVersion === 1 ? 1 : 2));
});

async function partiallySent(actorId: string) {
  const fixture = await seed(actorId);
  const { peer, route, message } = fixture;
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
  return { ...fixture, first, second };
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
  const { peer, route, message } = await partiallySent(actorId);
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

it("keeps a new delivery behind held output rejected with a retryable status", async () => {
  const actorId = "34690212222";
  const { peer, route, message } = await seed(actorId);
  const older = "held-message-awaiting-retry";
  await runInDurableObject(peer, async (instance) => {
    await instance["held"].hold({ deliveryId: "earlier-delivery", owner: route, markdown: older });
  });
  await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: older });
  try {
    using blocked = await peer.sendMessage(route.installationId, message);
    expect(blocked).toMatchObject({ ok: false, retryable: true });
    expect(await messages(actorId)).toEqual([]);
    await runInDurableObject(peer, async (_instance, state) => {
      expect(await state.storage.get(`outbound_delivery:v1:record:${message.deliveryId}`)).toMatchObject({ state: "retryable" });
    });
  } finally {
    await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: "" });
  }
  using retried = await peer.sendMessage(route.installationId, message);
  expect(retried).toMatchObject({ ok: true });
  expect((await messages(actorId)).map((record) => record.body.text?.body)).toEqual([older, message.text]);
});

it.each(["release", "message", "approval"] as const)("retries held output from an inbound %s without another webhook", async (kind) => {
  const actorId = `3469021333${kind === "release" ? 1 : kind === "message" ? 2 : 3}`;
  const { peer, route } = await seed(actorId);
  const interactionId = `wamid.retry.${kind}`;
  const heldText = `held-until-${kind}-retry`;
  await runInDurableObject(peer, async (instance) => {
    await instance["held"].hold({ deliveryId: interactionId, owner: route, markdown: heldText });
  });
  const event: ManagedWhatsAppPeerEvent = kind === "release"
    ? { kind, tap: { actorId, surfaceId: actorId, interactionId, timestamp: Date.now() } }
    : kind === "approval"
      ? { kind, reply: { actorId, surfaceId: actorId, interactionId, providerMessageId: "wamid.old", data: "expired-button", timestamp: Date.now() } }
      : { kind, inbound: { actorId, surfaceId: actorId, messageId: interactionId, deliveryId: interactionId, text: "hello", timestamp: Date.now(), unsupportedContent: false } };
  const receiptId = kind === "message" ? interactionId : `${kind === "release" ? "release" : "interactive"}:${whatsAppDeliveryToken(interactionId)}`;
  await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: heldText });
  try {
    await peer.handleWebhook(event);
    await vi.waitFor(async () => {
      const rejected = await (await bindings.WHATSAPP_API.fetch("https://graph.test/rejected")).json<Array<{ body: { to?: string } }>>();
      expect(rejected.some((record) => record.body.to === actorId)).toBe(true);
      await runInDurableObject(peer, async (instance, state) => {
        await instance["drainInbound"]();
        expect(await state.storage.get(`managed_whatsapp_peer:v1:inbound:${receiptId}`)).toMatchObject({ state: "provider" });
        expect(await state.storage.getAlarm()).not.toBeNull();
      });
    });
    expect(await messages(actorId)).toEqual([]);
  } finally {
    await bindings.WHATSAPP_API.fetch("https://graph.test/throttle", { method: "POST", body: "" });
  }
  await runInDurableObject(peer, async (instance, state) => {
    await instance.alarm();
    expect(await state.storage.get(`managed_whatsapp_peer:v1:inbound:${receiptId}`)).toMatchObject({ state: "completed" });
    expect(await instance["held"].list(route)).toEqual([]);
  });
  expect((await messages(actorId))[0]?.body.text?.body).toBe(heldText);
  expect((await messages(actorId)).filter((record) => record.body.text?.body === heldText)).toHaveLength(1);
});

it("retains held output when the window expires during release preparation", async () => {
  const actorId = "34690214445";
  const { peer, route } = await seed(actorId);
  await runInDurableObject(peer, async (instance, state) => {
    const held = instance["held"];
    await held.hold({ deliveryId: "window-expires", owner: route, markdown: "Still waiting" });
    const list = held.list;
    held.list = async (owner) => {
      const records = await list.call(held, owner);
      const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
      await state.storage.put(stateKey, { ...current, lastInboundAt: Date.now() - 25 * 60 * 60 * 1000 });
      return records;
    };
    try {
      expect(await instance["releaseHeld"](route)).toBe(false);
      expect(await list.call(held, route)).toHaveLength(1);
    } finally {
      held.list = list;
    }
    const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
    await state.storage.put(stateKey, { ...current, lastInboundAt: Date.now() });
    expect(await instance["releaseHeld"](route)).toBe(true);
    expect(await held.list(route)).toEqual([]);
  });
  expect((await messages(actorId)).map((message) => message.body.text?.body)).toEqual(["Still waiting"]);
});

it("retries a reopened-window race without keeping a duplicate held copy", async () => {
  const actorId = "34690214444";
  const { peer, route, message } = await seed(actorId, true);
  message.text = "long reply ".repeat(300).trimEnd();
  await runInDurableObject(peer, async (instance, state) => {
    const claim = instance["claimPendingTemplate"];
    instance["claimPendingTemplate"] = async (observed) => {
      const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
      await state.storage.put(stateKey, { ...current, lastInboundAt: Date.now() });
      return await claim.call(instance, observed);
    };
    try {
      expect(await instance.sendMessage(route.installationId, message)).toMatchObject({ ok: false, retryable: true });
      expect(await instance["held"].list(route)).toEqual([]);
    } finally {
      instance["claimPendingTemplate"] = claim;
    }
  });
  expect(await messages(actorId)).toEqual([]);
  using retried = await peer.sendMessage(route.installationId, message);
  expect(retried).toMatchObject({ ok: true });
  expect((await messages(actorId)).map((record) => record.body.text?.body)).toEqual([message.text]);
});

it("retries an unsent suffix after a local failure before the next provider call", async () => {
  const actorId = "34690207777";
  const { peer, route, message, first, second } = await partiallySent(actorId);
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
  expect(await messages(actorId)).toHaveLength(1);
  using retried = await peer.sendMessage(route.installationId, message);
  expect(retried).toMatchObject({ ok: true });
  expect((await messages(actorId)).map((record) => record.body.text?.body)).toEqual([first, second]);
});

it.each([false, true])("does not dispatch after the route changes during preparation (template: %s)", async (closed) => {
  const actorId = closed ? "34690208888" : "34690209999";
  const { peer, route, message } = await seed(actorId, closed);
  await runInDurableObject(peer, async (instance, state) => {
    const relink = async () => {
      const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
      await state.storage.put(stateKey, { ...current, activeRoute: { ...route, generation: "new-generation" } });
    };
    const release = instance["releaseHeld"];
    const claim = instance["claimPendingTemplate"];
    if (closed) {
      instance["claimPendingTemplate"] = async (observed) => {
        const result = await claim.call(instance, observed);
        await relink();
        return result;
      };
    } else {
      instance["releaseHeld"] = async (owner) => { const result = await release.call(instance, owner); await relink(); return result; };
    }
    try {
      expect(await instance.sendMessage(route.installationId, message)).toMatchObject({
        ok: false, error: "WhatsApp route changed before delivery",
      });
    } finally {
      instance["releaseHeld"] = release;
      instance["claimPendingTemplate"] = claim;
    }
  });
  expect(await messages(actorId)).toEqual([]);
});

it("rechecks the route between uploading media and sending it", async () => {
  const actorId = "34690210000";
  const { peer, route, message } = await seed(actorId);
  await runInDurableObject(peer, async (instance, state) => {
    const factory = instance["whatsAppFetch"];
    instance["whatsAppFetch"] = (...args) => {
      const fetcher = factory.apply(instance, args);
      return async (input, init) => {
        const response = await fetcher(input, init);
        if (String(input).endsWith("/media")) {
          const current = (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!;
          await state.storage.put(stateKey, { ...current, activeRoute: { ...route, generation: "new-generation" } });
        }
        return response;
      };
    };
    try {
      expect(await instance.sendMessage(route.installationId, {
        ...message,
        media: [{ type: "image", mimeType: "image/png", filename: "test.png", size: 4, body: { offset: 0, length: 4 } }],
      }, binaryBodyFromOwnedBytes(new Uint8Array([1, 2, 3, 4])))).toMatchObject({
        ok: false, error: "WhatsApp route changed before delivery",
      });
    } finally {
      instance["whatsAppFetch"] = factory;
    }
  });
  expect(await messages(actorId)).toEqual([]);
});


it("preserves Meta failure diagnostics when replaying a terminal delivery receipt", async () => {
  const { peer, route, message } = await seed("34690219999");
  message.text = "graph rejects this";
  using first = await peer.sendMessage(route.installationId, message);
  expect(first).toMatchObject({ ok: false, diagnostics: {
    exceptionName: "ManagedWhatsAppDeliveryError", errorCode: "131026",
    providerStatusCode: 400, exceptionMessage: expect.stringContaining("rejected"),
  } });
  using replay = await peer.sendMessage(route.installationId, message);
  expect(replay).toEqual(first);
});
