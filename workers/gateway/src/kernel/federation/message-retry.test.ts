import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import { FederationStore } from "../federation-store";
import type { KernelContext } from "../context";
import { handleContactDeliveryList, handleContactDeliveryRetry } from "../federation";
import { DurableTaskScheduler } from "../../shared/durable-tasks";
import { z } from "zod";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("human message delivery recovery", () => {
  it("retries the exact stored message and fences outcomes from the previous retry epoch", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact, deliveryId } = fixture(storage);
      const original = store.outbox(deliveryId)!;
      expect(store.markOutboxFailed(deliveryId, contact.generation, "pending", "Response lost", null, true, Date.now(), true)).toBe(true);
      const failed = handleContactDeliveryList({ contactId: contact.id, deliveryIds: [deliveryId] }, ctx).deliveries[0];
      expect(failed).toMatchObject({ state: "failed", retryable: true });
      await expect(handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: failed.updatedAtMs }, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      const retried = await handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: failed.updatedAtMs }, ctx);
      expect(retried).toMatchObject({ deliveryId, state: "queued" });
      const pending = store.outbox(deliveryId)!;
      expect(pending).toMatchObject({ idempotencyKey: original.idempotencyKey, fingerprint: original.fingerprint, retryEpoch: 1 });
      expect(store.markOutboxFailed(deliveryId, contact.generation, "pending", "Late failure", null, true, Date.now(), false, 0)).toBe(false);
      expect(store.markDeliverySucceeded(deliveryId, contact.generation, Date.now(), 0)).toBe(false);
      expect(store.markDeliverySucceeded(deliveryId, contact.generation, Date.now(), 1)).toBe(true);
      expect(ctx.scheduleFederationDelivery).toHaveBeenCalledWith(deliveryId, expect.any(Number), false);
      await expect(handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: failed.updatedAtMs }, ctx)).rejects.toThrow("cannot be retried");
    });
  });

  it("keeps a successor when retry arrives before the failed background task exits", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const { ctx, store, contact, deliveryId } = fixture(storage);
      const tasks = new DurableTaskScheduler(storage,
        (callback, payload) => ({ callback, payload: z.string().parse(JSON.parse(payload)) }),
        async () => {
          const record = store.outbox(deliveryId)!;
          if (record.retryEpoch === 0) {
            store.markOutboxFailed(deliveryId, contact.generation, "pending", "Response lost", null, true, Date.now(), true);
            await handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: store.outbox(deliveryId)!.updatedAtMs }, ctx);
          } else {
            store.markDeliverySucceeded(deliveryId, contact.generation, Date.now(), record.retryEpoch);
          }
        });
      ctx.scheduleFederationDelivery = async (id, due, idempotent) => {
        await tasks.schedule(new Date(due), { callback: "onFederationDelivery", payload: id }, { idempotent });
      };
      const original = await tasks.schedule(new Date(Date.now()), { callback: "onFederationDelivery", payload: deliveryId });
      await tasks.alarm();
      const pending = sql.exec<{ id: string }>("SELECT id FROM cf_agents_schedules WHERE callback = 'onFederationDelivery'").toArray();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).not.toBe(original.id);
      expect(store.outbox(deliveryId)).toMatchObject({ state: "pending", retryEpoch: 1 });
      await tasks.alarm();
      expect(store.outbox(deliveryId)?.state).toBe("delivered");
    });
  });

  it("refuses unknown/foreign records, permanent failures and messages beyond receipt retention", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact, deliveryId } = fixture(storage, Date.now() - 8 * 24 * 60 * 60_000);
      store.markOutboxFailed(deliveryId, contact.generation, "pending", "Response lost", null, true, Date.now(), true);
      const record = store.outbox(deliveryId)!;
      expect(handleContactDeliveryList({ contactId: contact.id, deliveryIds: [deliveryId] }, ctx).deliveries[0].retryable).toBe(false);
      await expect(handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: record.updatedAtMs }, ctx)).rejects.toThrow("cannot be retried");
      await expect(handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: record.updatedAtMs }, { ...ctx, callerOwnerUid: 1002 })).rejects.toThrow("not found");
      await expect(handleContactDeliveryRetry({ deliveryId: "delivery:unknown", expectedUpdatedAtMs: 0 }, ctx)).rejects.toThrow("not found");
      expect(() => handleContactDeliveryList({ contactId: contact.id, messageSequences: Array(100).fill(1), deliveryIds: [deliveryId] }, ctx)).toThrow("at most 100");
    });
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact, deliveryId } = fixture(storage);
      store.markOutboxFailed(deliveryId, contact.generation, "pending", "Peer refused", null, true);
      const record = store.outbox(deliveryId)!;
      await expect(handleContactDeliveryRetry({ deliveryId, expectedUpdatedAtMs: record.updatedAtMs }, ctx)).rejects.toThrow("cannot be retried");
    });
  });
});

function fixture(storage: DurableObjectStorage, createdAt = Date.now()) {
  const store = new FederationStore(storage);
  const contact = store.activateContact({
    ownerUid: OWNER.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    sharedSecret: "secret", generation: "generation:one", threadId: "thread:one",
  });
  const deliveryId = "delivery:one";
  store.enqueue({ deliveryId, ownerUid: OWNER.uid, contactId: contact.id, contactGeneration: contact.generation,
    idempotencyKey: "intent:one", fingerprint: "fingerprint:one", now: createdAt,
    payload: { kind: "message", messageId: "message:one", threadId: contact.threadId, text: "Approved message" } });
  const context = {
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, federation: store, broadcastToUserUid: vi.fn(), scheduleFederationDelivery: vi.fn(async () => {}),
    procs: { get: () => null },
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
  };
  // SAFETY: real delivery storage with explicit authentication and scheduling boundaries.
  return { ctx: context as KernelContext, store, contact, deliveryId };
}
