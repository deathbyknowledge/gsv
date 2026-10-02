import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ManagedWhatsAppPeerEnv } from "../src/managed-peer";
import type { WhatsAppLifecycleEntrypoint } from "../src/lifecycle";
import type { ManagedWhatsAppPairingRecord } from "../src/managed-pairing";
import type { ManagedWhatsAppPeerState } from "../src/managed-peer-state";
import { inspectAdapterHilOwnership } from "../../shared/src/hil-approval";

// SAFETY: the fixture declares these concrete Worker and namespace bindings.
const bindings = env as ManagedWhatsAppPeerEnv & { LIFECYCLE: Service<WhatsAppLifecycleEntrypoint> };
const installationId = "retired-whatsapp-fixture";
const request = { version: 1 as const, installationId, operationId: "retire-whatsapp-fixture" };
const stateKey = "managed_whatsapp_peer:v1:state";

type ReplyButton = { type: "reply"; reply: { id: string; title: string } };
type GraphRecord = {
  kind: string;
  body: { to?: string; interactive?: { action: { buttons: ReplyButton[] } } };
  result: { id?: string };
};

async function pair(surfaceId: string, space: string) {
  const peer = bindings.MANAGED_WHATSAPP_PEER.getByName(`managed:${surfaceId}`);
  await peer.handleWebhook({ kind: "message", inbound: {
    deliveryId: `message:first-${surfaceId}`, messageId: `wamid.first.${surfaceId}`, actorId: surfaceId, surfaceId,
    text: "/start", unsupportedContent: false, timestamp: Date.now(),
  } });
  const pending = await runInDurableObject(peer, async (_instance, state) => (await state.storage.get<ManagedWhatsAppPeerState>(stateKey))!.pairing!);
  const claim = bindings.MANAGED_WHATSAPP_PAIRING.getByName(`pair:${pending.code}`);
  const input = { code: pending.code, installationId: space, localUid: 1000, operationId: `pair-${surfaceId}`, canonicalOrigin: "https://fixture.gsv.space" };
  const prepared = await claim.prepare(input);
  await expect((async () => await claim.prepare({ ...input, localUid: 1001 }))()).rejects.toThrow("identity changed");
  const active = { code: pending.code, operationId: input.operationId, route: prepared.route, canonicalOrigin: input.canonicalOrigin };
  await claim.activate(active);
  await claim.finalize(active);
  return { peer, claim, pending, route: prepared.route };
}

describe("WhatsApp installation retirement", () => {
  it("fences a held human approval, erases only its space, and preserves the shared number and another route", async () => {
    const own = await pair("34690101010", installationId);
    const other = await pair("34690202020", "preserved-whatsapp-fixture");
    const context = {
      deliveryId: "retirement-hil", accountId: "managed", actorId: "34690101010", surface: { kind: "dm" as const, id: "34690101010" },
      routeGeneration: own.route.generation, processId: "child-fixture", runId: "run-fixture", processMode: "work" as const,
      hil: { pid: "child-fixture", requestId: "held-retirement-approval", runId: "run-fixture", callId: "call-fixture", toolName: "Shell", syscall: "shell.exec", target: "gsv", args: { input: "date" }, createdAt: Date.now() },
    };
    expect(await own.peer.sendMessage(installationId, { deliveryId: context.deliveryId, surface: context.surface, actorId: context.actorId, routeGeneration: own.route.generation, text: "" }, undefined, context)).toMatchObject({ ok: true });
    const records: GraphRecord[] = await (await bindings.WHATSAPP_API!.fetch("https://fixture/records")).json();
    const control = records.reverse().find((record) => record.kind === "message" && record.body.to === "34690101010" && record.body.interactive)!;
    await own.peer.handleWebhook({ kind: "approval", reply: { interactionId: "wamid.held.fixture", actorId: "34690101010", surfaceId: "34690101010", providerMessageId: control.result.id!, data: control.body.interactive!.action.buttons[0]!.reply.id } });
    await vi.waitFor(async () => {
      const calls: Array<{ call: string; args: { requestId?: string } }> = await (await bindings.GATEWAY.fetch("https://fixture/calls")).json();
      expect(calls.some((call) => call.call === "proc.hil" && call.args.requestId === "held-retirement-approval")).toBe(true);
    });
    await bindings.LIFECYCLE.inspectInstallationDeletion({ installationId, resources: [] });
    const resources = [
      { kind: "adapter-installation" as const, name: installationId, objectId: bindings.WHATSAPP_INSTALLATIONS.idFromName(installationId).toString(), namespaceId: "1".repeat(32) },
      { kind: "adapter-peer" as const, name: "managed:34690101010", objectId: bindings.MANAGED_WHATSAPP_PEER.idFromName("managed:34690101010").toString(), namespaceId: "2".repeat(32) },
      { kind: "adapter-pairing" as const, name: `pair:${own.pending.code}`, objectId: bindings.MANAGED_WHATSAPP_PAIRING.idFromName(`pair:${own.pending.code}`).toString(), namespaceId: "3".repeat(32) },
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
      expect((await state.storage.get<ManagedWhatsAppPeerState>(stateKey))?.activeRoute).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await instance.installationDeletionStatus(request)).toMatchObject({ phase: "live-erased" });
    });
    expect(await own.claim.inspectInstallationResource(installationId)).toMatchObject({ outcome: "empty" });
    await expect((async () => await own.claim.activate({ code: own.pending.code, operationId: "late", route: own.route, canonicalOrigin: "https://fixture.gsv.space" }))()).rejects.toThrow("retired");
    expect(await other.peer.sendMessage(other.route.installationId, { deliveryId: "preserved-after-retirement", surface: { kind: "dm", id: "34690202020" }, actorId: "34690202020", routeGeneration: other.route.generation, text: "preserved" })).toMatchObject({ ok: true });
  });

  it("restores the retained claim's expiry alarm after removing a retired previous-route cleanup", async () => {
    const claim = bindings.MANAGED_WHATSAPP_PAIRING.getByName("pair:RETIREMENTEXPIRY");
    await runInDurableObject(claim, async (instance, state) => {
      const key = "managed_whatsapp_pairing:v1";
      await state.storage.put(key, {
        version: 1, claimId: "expiry-fixture", surfaceId: "34690303030", resourceName: "pair:RETIREMENTEXPIRY",
        owner: { installationId: "preserved-space", generation: "current-route" }, expiresAt: Date.now() - 1000,
        retainUntil: Date.now() - 1, operationId: "pair-current", stage: "finalized",
        cleanup: { operationId: "pair-current", actorId: "34690303030", surfaceId: "34690303030", installationId, localUid: 1000, generation: "retired-route" }, cleanupComplete: false,
      } satisfies ManagedWhatsAppPairingRecord);
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
