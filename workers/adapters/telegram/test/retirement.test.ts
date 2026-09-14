import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ManagedTelegramPeerEnv } from "../src/managed-peer";
import type { TelegramLifecycleEntrypoint } from "../src/lifecycle";
import type { ManagedTelegramPairingRecord } from "../src/managed-pairing";
import type { ManagedTelegramPeerState } from "../src/managed-peer-state";
import { inspectAdapterHilOwnership } from "../../shared/src/hil-approval";

// SAFETY: the fixture declares these concrete Worker and namespace bindings.
const bindings = env as ManagedTelegramPeerEnv & { LIFECYCLE: Service<TelegramLifecycleEntrypoint> };
const installationId = "retired-telegram-fixture";
const request = { version: 1 as const, installationId, operationId: "retire-telegram-fixture" };
const stateKey = "managed_telegram_peer:v1:state";

async function pair(surfaceId: string, space: string) {
  const peer = bindings.MANAGED_TELEGRAM_PEER.getByName(`managed:${surfaceId}`);
  await peer.handleWebhook({ kind: "message", inbound: {
    deliveryId: `first:${surfaceId}`, messageId: `1`, actorId: surfaceId, surfaceId,
    text: "/start", sequence: 1, unsupportedContent: false, timestamp: Date.now(),
  } });
  const pending = await runInDurableObject(peer, async (_instance, state) => (await state.storage.get<ManagedTelegramPeerState>(stateKey))!.pairing!);
  const claim = bindings.MANAGED_TELEGRAM_PAIRING.getByName(`pair:${pending.code}`);
  const input = { code: pending.code, installationId: space, localUid: 1000, operationId: `pair-${surfaceId}`, canonicalOrigin: "https://fixture.gsv.space" };
  const prepared = await claim.prepare(input);
  await expect((async () => await claim.prepare({ ...input, localUid: 1001 }))()).rejects.toThrow("identity changed");
  const active = { code: pending.code, operationId: input.operationId, route: prepared.route, canonicalOrigin: input.canonicalOrigin };
  await claim.activate(active);
  await claim.finalize(active);
  return { peer, claim, pending, route: prepared.route };
}

describe("Telegram installation retirement", () => {
  it("fences a held human approval, erases only its space, and preserves the shared bot and another route", async () => {
    const own = await pair("90101", installationId);
    const other = await pair("90102", "preserved-telegram-fixture");
    const context = {
      deliveryId: "retirement-hil", accountId: "managed", actorId: "90101", surface: { kind: "dm" as const, id: "90101" },
      routeGeneration: own.route.generation, processId: "child-fixture", runId: "run-fixture", processMode: "work" as const,
      hil: { pid: "child-fixture", requestId: "held-retirement-approval", runId: "run-fixture", callId: "call-fixture", toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "date" }, createdAt: Date.now() },
    };
    expect(await own.peer.sendMessage(installationId, { deliveryId: context.deliveryId, surface: context.surface, actorId: context.actorId, routeGeneration: own.route.generation, text: "" }, undefined, context)).toMatchObject({ ok: true });
    const messages: Array<{ body: { chat_id?: string; reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }; result: { message_id: number } }> = await (await bindings.TELEGRAM_API!.fetch("https://fixture/messages")).json();
    const control = messages.reverse().find((message) => message.body.chat_id === "90101" && message.body.reply_markup?.inline_keyboard.length)!;
    await own.peer.handleWebhook({ kind: "approval", callback: { callbackQueryId: "held-fixture", actorId: "90101", surfaceId: "90101", providerMessageId: String(control.result.message_id), data: control.body.reply_markup!.inline_keyboard[0][0].callback_data } });
    await vi.waitFor(async () => {
      const calls: Array<{ call: string; args: { requestId?: string } }> = await (await bindings.GATEWAY.fetch("https://fixture/calls")).json();
      expect(calls.some((call) => call.call === "proc.hil" && call.args.requestId === "held-retirement-approval")).toBe(true);
    });
    await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [] });
    const resources = [
      { kind: "adapter-installation" as const, name: installationId, objectId: bindings.TELEGRAM_INSTALLATIONS.idFromName(installationId).toString(), namespaceId: "1".repeat(32) },
      { kind: "adapter-peer" as const, name: "managed:90101", objectId: bindings.MANAGED_TELEGRAM_PEER.idFromName("managed:90101").toString(), namespaceId: "2".repeat(32) },
      { kind: "adapter-pairing" as const, name: `pair:${own.pending.code}`, objectId: bindings.MANAGED_TELEGRAM_PAIRING.idFromName(`pair:${own.pending.code}`).toString(), namespaceId: "3".repeat(32) },
    ];
    expect(await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources })).toMatchObject({ observations: resources.map((resource) => ({ ...resource, outcome: "identified", installationId })) });
    expect(await bindings.LIFECYCLE.importInstallationDeletionInventory({ installationId, discoverySha256: "a".repeat(64), resources })).toMatchObject({ outcome: "verified" });
    expect(await bindings.LIFECYCLE.quiesceInstallation(request)).toMatchObject({ phase: "quiescing" });
    await bindings.GATEWAY.fetch("https://fixture/release-approval");
    await vi.waitFor(async () => {
      await bindings.LIFECYCLE.quiesceInstallation(request);
      expect(await bindings.LIFECYCLE.eraseInstallation(request)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
    });
    await runInDurableObject(own.peer, async (instance, state) => {
      expect(await inspectAdapterHilOwnership(state.storage, installationId)).toMatchObject({ ownedCount: 0 });
      expect((await state.storage.get<ManagedTelegramPeerState>(stateKey))?.activeRoute).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await instance.installationDeletionStatus(request)).toMatchObject({ phase: "live-erased" });
    });
    expect(await own.claim.inspectInstallationResource(installationId)).toMatchObject({ outcome: "empty" });
    await expect((async () => await own.claim.activate({ code: own.pending.code, operationId: "late", route: own.route, canonicalOrigin: "https://fixture.gsv.space" }))()).rejects.toThrow("retired");
    expect(await other.peer.sendMessage(other.route.installationId, { deliveryId: "preserved-after-retirement", surface: { kind: "dm", id: "90102" }, actorId: "90102", routeGeneration: other.route.generation, text: "preserved" })).toMatchObject({ ok: true });
  });
  it("restores the retained claim's expiry alarm after removing a retired previous-route cleanup", async () => {
    const claim = bindings.MANAGED_TELEGRAM_PAIRING.getByName("pair:RETIREMENTEXPIRY");
    await runInDurableObject(claim, async (instance, state) => {
      const key = "managed_telegram_pairing:v1";
      await state.storage.put(key, {
        version: 1, claimId: "expiry-fixture", surfaceId: "90103", resourceName: "pair:RETIREMENTEXPIRY",
        owner: { installationId: "preserved-space", generation: "current-route" }, expiresAt: Date.now() - 1000,
        retainUntil: Date.now() - 1, operationId: "pair-current", stage: "finalized",
        cleanup: { operationId: "pair-current", actorId: "90103", surfaceId: "90103", installationId, localUid: 1000, generation: "retired-route" }, cleanupComplete: false,
      } satisfies ManagedTelegramPairingRecord);
      await instance.quiesceInstallation(request);
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await instance.eraseInstallation(request)).toMatchObject({ phase: "live-erased" });
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm();
      expect(await state.storage.get(key)).toBeUndefined();
    });
  });

});
