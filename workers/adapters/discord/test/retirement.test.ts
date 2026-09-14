import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AdapterRetirement } from "../../shared/src/retirement";
import { AdapterPeerRetirement } from "../../shared/src/peer-retirement";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import { InboundDeliveryLedger } from "../../shared/src/inbound-delivery";
import type { AdapterPeerLink } from "../../shared/src/pairing-route";
import type { SharedDiscordEnv } from "../src/shared-application";

// SAFETY: the Wrangler fixture binds the concrete Discord namespaces.
const bindings = env as SharedDiscordEnv;
const a = { installationId: "retired-space", generation: "old-generation" };
const b = { installationId: "preserved-space", generation: "new-generation" };
const request = { version: 1 as const, installationId: a.installationId, operationId: "retire-fixture" };

describe("shared adapter retirement over real Durable Object storage", () => {
  it("keeps a newer route and receipts while fencing a late older-generation result", async () => {
    const stub = bindings.DISCORD_PEER.getByName("peer-retirement-fixture");
    await runInDurableObject(stub, async (_instance, state) => {
      const fence = new AdapterRetirement(state.storage);
      const outbound = new DeliveryLedger(state.storage, { retirement: fence });
      const inbound = new InboundDeliveryLedger<string>(state.storage, "fixture:inbound:", { retirement: fence, completedRetentionMs: 60_000 });
      const retirement = new AdapterPeerRetirement<AdapterPeerLink>(state.storage, fence, {
        stateKey: "fixture:state", inboundPrefix: "fixture:inbound:", inbound, outbound, hil: false,
        identity: () => ({ name: "peer-retirement-fixture", understood: true }),
      });
      const route = { ...b, localUid: 1000, canonicalOrigin: "https://preserved.example", linkedAt: Date.now() };
      await state.storage.put("fixture:state", { activeRoute: route, lastDisconnect: { operationId: "old", route: { ...route, ...a } } });
      const oldClaim = await outbound.claim("old-send", "a".repeat(64), a);
      const newClaim = await outbound.claim("new-send", "b".repeat(64), b);
      if (!oldClaim.claimed || !newClaim.claimed) throw new Error("expected new claims");
      await outbound.succeed("new-send", newClaim.attemptId, "new-provider-receipt");
      await inbound.enqueueAndArm("old-ingress", "private fixture", Date.now() + 60_000, a);
      await inbound.enqueueAndArm("new-ingress", "preserved fixture", Date.now() + 60_000, b);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const pending = inbound.attempt("old-ingress", async () => { entered(); await gate; return { terminal: true }; });
      await started;
      expect(await retirement.quiesce(request)).toMatchObject({ phase: "quiescing" });
      expect(await retirement.erase(request)).toMatchObject({ phase: "quiescing" });
      release();
      await pending;
      expect(await retirement.erase(request)).toMatchObject({ phase: "live-erased", pendingResources: 0, outcome: "retention-pending" });
      await outbound.succeed("old-send", oldClaim.attemptId, "late-receipt");
      expect(await outbound.inspectOwnership(a.installationId)).toMatchObject({ ownedCount: 0 });
      expect(await inbound.inspectOwnership(a.installationId)).toMatchObject({ ownedCount: 0 });
      expect(await outbound.claim("new-send", "b".repeat(64), b)).toMatchObject({ claimed: false, result: { ok: true, messageId: "new-provider-receipt" } });
      expect(await inbound.pendingIds()).toEqual(["new-ingress"]);
      expect(await state.storage.get<AdapterPeerLink>("fixture:state")).toEqual({ activeRoute: route });
      const reconstructed = new AdapterRetirement(state.storage);
      expect(() => reconstructed.start(a)).toThrow("retired");
      await expect(outbound.claim("late-new-send", "c".repeat(64), a)).rejects.toThrow("retired");
      await expect(inbound.enqueueAndArm("late-ingress", "late", Date.now() + 1000, a)).rejects.toThrow("retired");
      expect(() => reconstructed.quiesce({ ...request, operationId: "wrong-operation" })).toThrow("immutable");
    });
  });

  it("does not guess the owner of historical receipts or erase another owner's state", async () => {
    const stub = bindings.DISCORD_PEER.getByName("peer-unattributed-fixture");
    await runInDurableObject(stub, async (_instance, state) => {
      const fence = new AdapterRetirement(state.storage);
      const outbound = new DeliveryLedger(state.storage, { retirement: fence });
      const inbound = new InboundDeliveryLedger<string>(state.storage, "fixture:inbound:", { retirement: fence });
      const retirement = new AdapterPeerRetirement<AdapterPeerLink>(state.storage, fence, {
        stateKey: "fixture:state", inboundPrefix: "fixture:inbound:", inbound, outbound, hil: false,
        identity: () => ({ name: "peer-unattributed-fixture", understood: true }),
      });
      await outbound.claim("historical", "d".repeat(64));
      await outbound.claim("attributed", "e".repeat(64), b);
      expect(await retirement.inspect(a.installationId)).toMatchObject({ outcome: "unidentified" });
      expect(await retirement.erase(request)).toMatchObject({ outcome: "missing-inventory" });
      expect((await state.storage.list({ prefix: "outbound_delivery:v1:record:" })).size).toBe(2);
    });
  });
});
