import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { FederationStore } from "../federation-store";
import { ApproachStore } from "../approach-store";
import { ResponsibilityStore } from "../responsibility-store";
import { handleContactBlockSet, handleContactPreferencesUpdate } from "./preferences";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("contact policy authority", () => {
  it("lets only the owner's canonical Ship change handling and retains revision checks", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const store = new FederationStore(storage);
      const contact = store.activateContact({ ownerUid: OWNER.uid, remoteDid: "did:plc:remoteaaaaaaaaaaaaaaaaaa", remoteName: "Remote",
        generation: "generation:one", threadId: "thread:one" });
      const ctx = policyContext(storage, store);
      const change = { contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } };
      for (const processId of ["proc:helper", "proc:foreign"]) {
        await expect(handleContactPreferencesUpdate(change, { ...ctx, processId })).rejects.toThrow("signed-in human or their Ship");
      }
      const ship = { ...ctx, processId: "proc:ship" };
      const result = await handleContactPreferencesUpdate(change, ship);
      expect(result.contact.preferences).toMatchObject({ revision: 2, shipHandlesMessages: true });
      expect(ctx.responsibilities.list(OWNER.uid).records).toEqual([]);
      await expect(handleContactPreferencesUpdate({ ...change, patch: { shipHandlesMessages: false } }, ship)).rejects.toThrow("changed");
      expect(store.get(contact.id)?.preferences.shipHandlesMessages).toBe(true);
    });
  });

  it("blocks the DID, pending transport, pairing and resource grants in one owner transition", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const store = new FederationStore(storage);
      const did = "did:plc:remoteaaaaaaaaaaaaaaaaaa";
      const contact = store.activateContact({ ownerUid: OWNER.uid, remoteDid: did, remoteName: "Remote", generation: "generation:one", threadId: "thread:one" });
      const payload = {
        kind: "message" as const, messageId: "message:queued", threadId: contact.threadId, text: "Queued",
        social: { threadId: contact.threadId, reference: { did, messageId: "message:queued" }, provenance: { kind: "human" as const } },
      };
      store.enqueue({
        deliveryId: "delivery:queued", ownerUid: OWNER.uid, contactId: contact.id, contactGeneration: contact.generation,
        idempotencyKey: "key:queued", fingerprint: "hash:queued", payload,
      });
      store.receive({ contactId: contact.id, contactGeneration: contact.generation, deliveryId: "delivery:pending", payload, payloadHash: "hash:pending" });
      store.beginPairingAttempt({ tokenHash: "token:pending", ownerUid: OWNER.uid, remoteDid: did, expiresAtMs: Date.now() + 60_000 });
      const grant = store.createGrant({
        contactId: contact.id, contactGeneration: contact.generation, sourceUid: OWNER.uid,
        source: { type: "resource", ref: { type: "file", target: "gsv", path: "/file.txt", revision: "revision:one", size: 4, contentType: "text/plain" } },
        descriptor: { revision: "revision:one", size: 4, contentType: "text/plain" },
      });
      const ctx = policyContext(storage, store);
      await expect(handleContactBlockSet({ did, blocked: true }, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      await expect(handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { muted: true } }, { ...ctx, processId: "proc:helper" })).rejects.toThrow("signed-in human");
      expect(store.get(contact.id)?.state).toBe("active");

      await handleContactBlockSet({ did, blocked: true }, ctx);
      expect(store.listBlocks(OWNER.uid, 50, undefined, did).blocks).toEqual([expect.objectContaining({ did, displayName: "Remote" })]);
      expect(store.listBlocks(OWNER.uid + 1, 50, undefined, did).blocks).toEqual([]);
      expect(store.listBlocks(OWNER.uid, 50, undefined, "did:plc:anotheraaaaaaaaaaaaaaaaa").blocks).toEqual([]);
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: true });
      expect(store.outbox("delivery:queued")?.state).toBe("terminal");
      expect(store.inbox(contact.id, contact.generation, "delivery:pending")?.state).toBe("rejected");
      expect(store.grant(grant.id)).toBeNull();
      expect(store.pairingAttempt("token:pending")).toMatchObject({ state: "terminal", terminalReason: "actor-blocked" });
      await handleContactBlockSet({ did, blocked: false }, ctx);
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: false });
      expect(store.outbox("delivery:queued")?.state).toBe("terminal");
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "contact.changed");
    });
  });
});

function policyContext(storage: DurableObjectStorage, federation: FederationStore): KernelContext {
  const context = {
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, federation, approaches: new ApproachStore(storage), responsibilities: new ResponsibilityStore(storage),
    procs: { get: (id: string) => ({ ownerUid: id === "proc:foreign" ? OWNER.uid + 1 : OWNER.uid, isPersonalController: id !== "proc:helper" }) },
    auth: {
      getPasswdByUid: () => OWNER,
      getShadowByUsername: () => ({ hash: "unlocked" }),
      isPersonalAgentUid: () => false,
    },
    coordinateFederationContact: async <T>(_id: string, operation: () => T | Promise<T>) => operation(),
    broadcastToUserUid: vi.fn(), reconcileResponsibilityWake: vi.fn(async () => {}),
  };
  // SAFETY: these policy handlers use only the real stores and explicit owner callbacks supplied here.
  return context as KernelContext;
}
