import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { FederationStore } from "../federation-store";
import { ResponsibilityStore } from "../responsibility-store";
import { handleContactBlockSet, handleContactPreferencesUpdate } from "./preferences";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("contact policy authority", () => {
  it("blocks the actor, pending transport, pairing and resource grants in one owner transition", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const store = new FederationStore(storage);
      const contact = store.activateContact({
        ownerUid: OWNER.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Remote" },
        remoteOrigin: "https://remote.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        sharedSecret: "secret", generation: "generation:one", threadId: "thread:one",
      });
      const actor = { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id };
      const payload = { kind: "message" as const, messageId: "message:queued", threadId: contact.threadId, text: "Queued" };
      store.enqueue({
        deliveryId: "delivery:queued", ownerUid: OWNER.uid, contactId: contact.id, contactGeneration: contact.generation,
        idempotencyKey: "key:queued", fingerprint: "hash:queued", payload,
      });
      store.receive({ contactId: contact.id, contactGeneration: contact.generation, deliveryId: "delivery:pending", payload, payloadHash: "hash:pending" });
      store.beginPairingAttempt({
        tokenHash: "token:pending", ownerUid: OWNER.uid, remoteShipId: actor.shipId, remoteSubjectId: actor.subjectId,
        remoteOrigin: contact.remoteOrigin, remotePublicKey: contact.remotePublicKey, expiresAtMs: Date.now() + 60_000,
      });
      const grant = store.createGrant({
        contactId: contact.id, contactGeneration: contact.generation, sourceUid: OWNER.uid,
        source: { type: "resource", ref: { type: "file", target: "gsv", path: "/file.txt", revision: "revision:one", size: 4, contentType: "text/plain" } },
        descriptor: { revision: "revision:one", size: 4, contentType: "text/plain" },
      });
      const ctx = policyContext(storage, store);
      await expect(handleContactBlockSet({ actor, blocked: true }, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      expect(() => handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { muted: true } }, { ...ctx, processId: "proc:helper" })).toThrow("signed-in human");
      expect(store.get(contact.id)?.state).toBe("active");

      await handleContactBlockSet({ actor, blocked: true }, ctx);
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: true });
      expect(store.outbox("delivery:queued")?.state).toBe("terminal");
      expect(store.inbox(contact.id, contact.generation, "delivery:pending")?.state).toBe("rejected");
      expect(store.grant(grant.id)).toBeNull();
      expect(store.pairingAttempt("token:pending")).toMatchObject({ state: "terminal", terminalReason: "actor-blocked" });
      await handleContactBlockSet({ actor, blocked: false }, ctx);
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: false });
      expect(store.outbox("delivery:queued")?.state).toBe("terminal");
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "contact.changed");
    });
  });
});

function policyContext(storage: DurableObjectStorage, federation: FederationStore): KernelContext {
  const context = {
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, federation, responsibilities: new ResponsibilityStore(storage),
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
