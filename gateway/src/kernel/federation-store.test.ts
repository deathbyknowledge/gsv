import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  ContactRequestRecord,
  FederationPublicKey,
} from "@humansandmachines/gsv/protocol";
import { getDurableObjectByName } from "../shared/durable-object";
import type { Kernel } from "./do";
import { FederationStore } from "./federation-store";

const PUBLIC_KEY: FederationPublicKey = {
  kty: "EC",
  crv: "P-256",
  x: "remote-x",
  y: "remote-y",
};

async function withStore<Result>(
  callback: (store: FederationStore, sql: SqlStorage) => Result | Promise<Result>,
): Promise<Result> {
  const kernel = await getDurableObjectByName<Env, Kernel>(
    env.KERNEL,
    `federation-store-${crypto.randomUUID()}`,
  );
  return await runInDurableObject(kernel, async (_instance: Kernel, state) => (
    await callback(new FederationStore(state.storage), state.storage.sql)
  ));
}

function activateContact(store: FederationStore) {
  store.ensureSubject(1000, "Local person", 1_000);
  return store.activateContact({
    ownerUid: 1000,
    remoteShipId: "ship:remote",
    remoteSubject: { id: "subject:remote", displayName: "Remote person" },
    remoteOrigin: "https://remote.example",
    remotePublicKey: PUBLIC_KEY,
    sharedSecret: "secret",
    generation: "generation:first",
    threadId: "thread:first",
    now: 1_000,
  });
}

describe("FederationStore", () => {
  it("keeps a local alias separate from refreshed remote identity", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      expect(store.setAlias(contact.id, 1000, "Flynn", 1_100)).toMatchObject({
        localAlias: "Flynn",
        remoteSubject: { displayName: "Remote person" },
      });

      expect(store.activateContact({
        ownerUid: 1000,
        remoteShipId: contact.remoteShipId,
        remoteSubject: { ...contact.remoteSubject, displayName: "Remote person renamed" },
        remoteOrigin: contact.remoteOrigin,
        remotePublicKey: PUBLIC_KEY,
        sharedSecret: "new-secret",
        generation: "generation:second",
        threadId: "thread:second",
        now: 1_200,
      })).toMatchObject({
        localAlias: "Flynn",
        remoteSubject: { displayName: "Remote person renamed" },
      });
      expect(store.setAlias(contact.id, 1000, null, 1_300).localAlias).toBeUndefined();
    });
  });

  it("lists invitation metadata and records explicit cancellation", async () => {
    await withStore((store) => {
      const pending = store.createInvite({
        ownerUid: 1000,
        tokenHash: "pending-token",
        issuingShipId: "ship:local",
        issuingOrigin: "https://local.example",
        expiresAtMs: 20_000,
        now: 1_000,
      });
      store.createInvite({
        ownerUid: 2000,
        tokenHash: "other-owner-token",
        issuingShipId: "ship:local",
        issuingOrigin: "https://local.example",
        expiresAtMs: 20_000,
        now: 2_000,
      });

      expect(store.listInvites(1000, false, 3_000)).toEqual([pending]);
      const cancelled = store.cancelInvite(pending.inviteId, 1000, 4_000);
      expect(cancelled).toMatchObject({ inviteId: pending.inviteId, cancelledAtMs: 4_000 });
      expect(store.listInvites(1000, false, 5_000)).toEqual([]);
      expect(store.listInvites(1000, true, 5_000)).toEqual([cancelled]);
      expect(() => store.cancelInvite(pending.inviteId, 2000, 6_000))
        .toThrow(`Contact invite not found: ${pending.inviteId}`);

      const consumable = store.createInvite({
        ownerUid: 1000,
        tokenHash: "consumable-token",
        issuingShipId: "ship:local",
        issuingOrigin: "https://local.example",
        expiresAtMs: 20_000,
        now: 1_000,
      });
      expect(store.acceptInvite({
        tokenHash: consumable.tokenHash,
        remoteShipId: "ship:remote",
        remoteSubjectId: "subject:remote",
        contactId: "contact:accepted",
        generation: "generation:accepted",
        threadId: "thread:accepted",
        response: { version: 1, status: "accepted" },
        now: 2_000,
      })).toBe(true);
      expect(store.acceptInvite({
        tokenHash: consumable.tokenHash,
        remoteShipId: "ship:other",
        remoteSubjectId: "subject:other",
        contactId: "contact:other",
        generation: "generation:other",
        threadId: "thread:other",
        response: { version: 1, status: "accepted" },
        now: 3_000,
      })).toBe(false);
      expect(store.invite(consumable.inviteId)).toMatchObject({
        state: "accepted",
        acceptedContactId: "contact:accepted",
        acceptedRemoteShipId: "ship:remote",
        acceptedGeneration: "generation:accepted",
        acceptedThreadId: "thread:accepted",
      });
    });
  });

  it("persists one current pairing attempt before it can commit a contact", async () => {
    await withStore((store) => {
      const firstInput = {
        tokenHash: "pairing:first",
        ownerUid: 1000,
        expiresAtMs: 20_000,
        remoteShipId: "ship:remote",
        remoteSubjectId: "subject:remote",
        remoteOrigin: "https://remote.example",
        remotePublicKey: PUBLIC_KEY,
        now: 1_000,
      };
      expect(store.beginPairingAttempt(firstInput)).toMatchObject({
        state: "pending",
        tokenHash: firstInput.tokenHash,
        remoteShipId: firstInput.remoteShipId,
      });
      expect(() => store.beginPairingAttempt({
        ...firstInput,
        remoteOrigin: "https://changed.example",
      })).toThrow("identity changed");
      expect(store.beginPairingAttempt({
        ...firstInput,
        tokenHash: "pairing:second",
        now: 2_000,
      })).toMatchObject({ state: "pending", tokenHash: "pairing:second" });
      expect(store.pairingAttempt(firstInput.tokenHash)).toMatchObject({
        state: "terminal",
        terminalReason: "superseded",
      });
      expect(() => store.commitPairingAttempt({
        tokenHash: firstInput.tokenHash,
        contactId: "contact:first",
        generation: "generation:first",
        threadId: "thread:first",
      })).toThrow("terminal");

      const committed = store.commitPairingAttempt({
        tokenHash: "pairing:second",
        contactId: "contact:second",
        generation: "generation:second",
        threadId: "thread:second",
        now: 3_000,
      });
      expect(committed).toMatchObject({
        state: "committed",
        contactId: "contact:second",
        generation: "generation:second",
      });
      expect(store.commitPairingAttempt({
        tokenHash: "pairing:second",
        contactId: "contact:second",
        generation: "generation:second",
        threadId: "thread:second",
        now: 4_000,
      })).toEqual(committed);
      expect(() => store.commitPairingAttempt({
        tokenHash: "pairing:second",
        contactId: "contact:second",
        generation: "generation:changed",
        threadId: "thread:second",
      })).toThrow("changed");
      store.beginPairingAttempt({
        ...firstInput,
        tokenHash: "pairing:rejected",
        now: 5_000,
      });
      expect(store.terminatePairingAttempt(
        "pairing:rejected",
        "remote-rejected:410",
        6_000,
      )).toMatchObject({
        state: "terminal",
        terminalReason: "remote-rejected:410",
        updatedAtMs: 6_000,
      });
      expect(() => store.commitPairingAttempt({
        tokenHash: "pairing:rejected",
        contactId: "contact:rejected",
        generation: "generation:rejected",
        threadId: "thread:rejected",
      })).toThrow("terminal");
    });
  });

  it("revokes contact grants and active requests", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const descriptor = store.createGrant({
        contactId: contact.id,
        contactGeneration: contact.generation,
        source: {
          type: "resource",
          ref: {
            type: "file",
            target: "gsv",
            path: "/home/local/archive/image.png",
            revision: "revision:first",
            contentType: "image/png",
            size: 10,
          },
        },
        sourceUid: 1000,
        descriptor: {
          revision: "revision:first",
          contentType: "image/png",
          size: 10,
        },
        now: 1_100,
      });
      store.createRequest({
        id: "request:revoked",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "outgoing",
        kind: "task",
        title: "Cancelled by contact revocation",
        state: "active",
        createdAtMs: 1_100,
        updatedAtMs: 1_100,
      });
      const revoked = store.revoke(contact.id, 1000, 2_000);
      expect(revoked).toMatchObject({ state: "revoked", revokedAtMs: 2_000 });
      expect(store.grant(descriptor.id)).toBeNull();
      expect(store.request("request:revoked")).toMatchObject({
        state: "cancelled",
        revision: 2,
        updatedAtMs: 2_000,
      });
    });
  });

  it("rejects pending inbox work when a contact is revoked", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const pending = store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: "delivery:pending-before-revoke",
        payloadHash: "hash:pending-before-revoke",
        payload: {
          kind: "message",
          messageId: "message:pending-before-revoke",
          threadId: contact.threadId,
          text: "Pending before revocation",
        },
        now: 1_100,
      }).record;
      const revocation = store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: "delivery:revoke",
        payloadHash: "hash:revoke",
        payload: {
          kind: "contact.revoked",
          generation: contact.generation,
        },
        now: 1_200,
      }).record;

      store.terminatePendingForRevokedContact(
        contact.id,
        contact.generation,
        revocation.deliveryId,
        2_000,
      );

      expect(store.inbox(contact.id, contact.generation, pending.deliveryId)).toMatchObject({
        state: "rejected",
        lastError: "Contact was revoked",
        updatedAtMs: 2_000,
      });
      expect(store.inbox(contact.id, contact.generation, revocation.deliveryId)).toMatchObject({
        state: "received",
      });
    });
  });

  it("terminates superseded grants, requests, and deliveries when a generation changes", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const descriptor = store.createGrant({
        contactId: contact.id,
        contactGeneration: contact.generation,
        source: {
          type: "resource",
          ref: {
            type: "file",
            target: "gsv",
            path: "/home/local/archive/image.png",
            revision: "revision:first",
            contentType: "image/png",
            size: 10,
          },
        },
        sourceUid: 1000,
        descriptor: {
          revision: "revision:first",
          contentType: "image/png",
          size: 10,
        },
        now: 1_100,
      });
      const pending = store.enqueue({
        deliveryId: "delivery:old-generation",
        ownerUid: contact.ownerUid,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "old-generation",
        fingerprint: "old-generation-fingerprint",
        payload: {
          kind: "message",
          messageId: "message:old-generation",
          threadId: contact.threadId,
          text: "Pending before re-pairing",
        },
        now: 1_100,
      }).record;
      store.createRequest({
        id: "request:old-generation",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "incoming",
        remoteId: "request:remote-old-generation",
        kind: "task",
        title: "Cancelled by contact re-pairing",
        state: "accepted",
        createdAtMs: 1_100,
        updatedAtMs: 1_100,
      });
      const received = store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: "delivery:received-old-generation",
        payloadHash: "hash:received-old-generation",
        payload: {
          kind: "message",
          messageId: "message:received-old-generation",
          threadId: contact.threadId,
          text: "Admitted before re-pairing",
        },
        now: 1_100,
      }).record;

      const replacement = store.transaction(() => store.activateContact({
        ownerUid: contact.ownerUid,
        remoteShipId: contact.remoteShipId,
        remoteSubject: contact.remoteSubject,
        remoteOrigin: contact.remoteOrigin,
        remotePublicKey: contact.remotePublicKey,
        sharedSecret: "replacement-secret",
        generation: "generation:second",
        threadId: "thread:second",
        now: 2_000,
      }));

      expect(replacement).toMatchObject({
        id: contact.id,
        generation: "generation:second",
      });
      expect(store.grant(descriptor.id)).toBeNull();
      expect(store.activeGrantCount(contact.id)).toBe(0);
      expect(store.outbox(pending.deliveryId)?.state).toBe("terminal");
      expect(store.inbox(contact.id, contact.generation, received.deliveryId)).toMatchObject({
        state: "rejected",
        lastError: "Contact generation changed",
        updatedAtMs: 2_000,
      });
      expect(store.pendingInboxCount(contact.id)).toBe(0);
      expect(store.request("request:old-generation")).toMatchObject({
        state: "cancelled",
        revision: 2,
        updatedAtMs: 2_000,
      });
      expect(store.markDeliverySucceeded(
        pending.deliveryId,
        pending.contactGeneration,
        3_000,
      )).toBe(false);
      expect(store.markOutboxFailed(
        pending.deliveryId,
        pending.contactGeneration,
        "pending",
        "late failure",
        4_000,
        false,
        3_000,
      )).toBe(false);
      expect(store.outbox(pending.deliveryId)).toMatchObject({
        state: "terminal",
        updatedAtMs: 2_000,
      });
    });
  });

  it("deduplicates outbox and inbox records without accepting changed content", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const delivery = {
        deliveryId: "delivery:first",
        ownerUid: 1000,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "send:first",
        fingerprint: "fingerprint:first",
        payload: {
          kind: "message" as const,
          messageId: "message:first",
          threadId: contact.threadId,
          text: "Hello",
        },
        now: 2_000,
      };
      const first = store.enqueue(delivery);
      const replay = store.enqueue(delivery);

      expect(first.created).toBe(true);
      expect(replay).toEqual({ record: first.record, created: false });
      expect(() => store.enqueue({ ...delivery, fingerprint: "fingerprint:changed" }))
        .toThrow("payload changed");

      const received = store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: delivery.deliveryId,
        payloadHash: "hash:first",
        payload: delivery.payload,
        now: 3_000,
      });
      expect(store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: delivery.deliveryId,
        payloadHash: "hash:first",
        payload: delivery.payload,
        now: 4_000,
      })).toEqual({ record: received.record, created: false });
      expect(() => store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: delivery.deliveryId,
        payloadHash: "hash:changed",
        payload: delivery.payload,
      })).toThrow("different payload");
      expect(store.commitInbox(
        contact.id,
        contact.generation,
        delivery.deliveryId,
        { version: 1, status: "committed" },
        5_000,
      )).toBe(true);
      expect(store.commitInbox(
        contact.id,
        contact.generation,
        delivery.deliveryId,
        { version: 1, status: "changed" },
        6_000,
      )).toBe(false);
      expect(store.inbox(contact.id, contact.generation, delivery.deliveryId))
        .toMatchObject({
          state: "committed",
          response: { version: 1, status: "committed" },
          committedAtMs: 5_000,
        });
    });
  });

  it("keeps delivery identities separate across contact generations", async () => {
    await withStore((store) => {
      const first = activateContact(store);
      const deliveryId = "delivery:reused-after-pairing";
      store.receive({
        contactId: first.id,
        contactGeneration: first.generation,
        deliveryId,
        payloadHash: "hash:first-generation",
        payload: {
          kind: "message",
          messageId: "message:first-generation",
          threadId: first.threadId,
          text: "First generation",
        },
        now: 1_100,
      });
      const second = store.activateContact({
        ownerUid: first.ownerUid,
        remoteShipId: first.remoteShipId,
        remoteSubject: first.remoteSubject,
        remoteOrigin: first.remoteOrigin,
        remotePublicKey: first.remotePublicKey,
        sharedSecret: "second-secret",
        generation: "generation:second",
        threadId: "thread:second",
        now: 2_000,
      });
      const admitted = store.receive({
        contactId: second.id,
        contactGeneration: second.generation,
        deliveryId,
        payloadHash: "hash:second-generation",
        payload: {
          kind: "message",
          messageId: "message:second-generation",
          threadId: second.threadId,
          text: "Second generation",
        },
        now: 2_100,
      });

      expect(admitted.created).toBe(true);
      expect(store.inbox(first.id, first.generation, deliveryId)).toMatchObject({
        state: "rejected",
        lastError: "Contact generation changed",
      });
      expect(store.inbox(second.id, second.generation, deliveryId)).toMatchObject({
        state: "received",
        payloadHash: "hash:second-generation",
      });
    });
  });

  it("correlates updates to both locally originated and remotely originated requests", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const outgoing: Omit<ContactRequestRecord, "revision"> = {
        id: "request:outgoing",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "outgoing",
        kind: "task",
        title: "Outgoing",
        details: { initial: true },
        state: "offered",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      };
      const incoming: Omit<ContactRequestRecord, "revision"> = {
        id: "request:incoming-local",
        remoteId: "request:incoming-remote",
        contactId: contact.id,
        contactGeneration: contact.generation,
        direction: "incoming",
        kind: "task",
        title: "Incoming",
        details: { initial: true },
        state: "offered",
        createdAtMs: 2_000,
        updatedAtMs: 2_000,
      };
      store.createRequest(outgoing);
      store.createRequest(incoming);

      expect(store.requestForRemoteUpdate(
        contact.id,
        contact.generation,
        outgoing.id,
      )?.id).toBe(outgoing.id);
      expect(store.requestForRemoteUpdate(
        contact.id,
        contact.generation,
        incoming.remoteId!,
      )?.id).toBe(incoming.id);
      expect(store.updateRequest({
        requestId: outgoing.id,
        expectedRevision: 1,
        state: "accepted",
        updatedAtMs: 3_000,
      })).toMatchObject({
        revision: 2,
        state: "accepted",
        details: { initial: true },
      });
    });
  });

  it("bounds rate windows and resource-read leases without charging rejected attempts", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const limits = [{
        scope: `contact:${contact.id}`,
        operation: "delivery.inbound",
        maximum: 2,
        windowMs: 60_000,
      }];

      expect(store.transaction(() => store.consumeRateLimits(limits, 1_000))).toBeNull();
      expect(store.transaction(() => store.consumeRateLimits(limits, 2_000))).toBeNull();
      expect(store.transaction(() => store.consumeRateLimits(limits, 3_000))).toBe(60_000);
      expect(store.transaction(() => store.consumeRateLimits(limits, 61_000))).toBeNull();

      const first = store.beginResourceRead(contact.id, contact.generation, 1, 10_000, 1_000);
      expect(first).toMatch(/^read:/);
      expect(store.beginResourceRead(
        contact.id,
        contact.generation,
        1,
        10_000,
        2_000,
      )).toBeNull();
      store.finishResourceRead(first!);
      expect(store.beginResourceRead(
        contact.id,
        contact.generation,
        1,
        10_000,
        3_000,
      )).toMatch(/^read:/);
    });
  });

  it("recovers every pending delivery and prunes only settled replay state", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const pending = store.enqueue({
        deliveryId: "delivery:pending",
        ownerUid: 1000,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "send:pending",
        fingerprint: "fingerprint:pending",
        payload: {
          kind: "message",
          messageId: "message:pending",
          threadId: contact.threadId,
          text: "Pending",
        },
        now: 1_000,
      }).record;
      store.markOutboxFailed(
        pending.deliveryId,
        pending.contactGeneration,
        "pending",
        "retry",
        500_000,
        false,
        2_000,
      );
      const source = {
        type: "resource" as const,
        ref: {
          type: "file" as const,
          target: "gsv",
          path: "/home/local/.gsv/media/archived-media:prepared",
          revision: "revision:prepared",
          contentType: "image/png",
          size: 10,
        },
      };
      const preparing = store.prepareMessage({
        deliveryId: "delivery:preparing",
        ownerUid: 1000,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "send:preparing",
        fingerprint: "fingerprint:preparing",
        preparation: {
          kind: "message",
          messageId: "message:preparing",
          threadId: contact.threadId,
          text: "Preparing",
          resources: [source],
          localMessage: {
            messageId: "message:preparing",
            text: "Preparing",
            author: { kind: "user", uid: 1000 },
            origin: { kind: "client" },
            processId: "proc:ship",
            createdAtMs: 1_500,
          },
        },
        now: 1_500,
      }).record;
      const settled = store.enqueue({
        deliveryId: "delivery:settled",
        ownerUid: 1000,
        contactId: contact.id,
        contactGeneration: contact.generation,
        idempotencyKey: "send:settled",
        fingerprint: "fingerprint:settled",
        payload: {
          kind: "message",
          messageId: "message:settled",
          threadId: contact.threadId,
          text: "Settled",
        },
        now: 1_000,
      }).record;
      store.markDeliverySucceeded(settled.deliveryId, settled.contactGeneration, 2_000);
      store.createInvite({
        ownerUid: 1000,
        tokenHash: "expired-token",
        issuingShipId: "ship:local",
        issuingOrigin: "https://local.example",
        expiresAtMs: 2_000,
        now: 1_000,
      });

      expect(store.recoverableOutbox(10).map((record) => record.deliveryId))
        .toEqual([pending.deliveryId, preparing.deliveryId]);
      expect(store.preparingResourceCount(contact.id)).toBe(1);
      const descriptor = store.createGrant({
        contactId: contact.id,
        contactGeneration: contact.generation,
        source,
        sourceUid: 1000,
        descriptor: {
          revision: source.ref.revision,
          contentType: source.ref.contentType,
          size: source.ref.size,
        },
        now: 2_500,
      });
      expect(store.completeMessagePreparation({
        deliveryId: preparing.deliveryId,
        contactGeneration: preparing.contactGeneration,
        payload: {
          kind: "message",
          messageId: preparing.preparation.messageId,
          threadId: preparing.preparation.threadId,
          text: preparing.preparation.text,
          resources: [descriptor],
        },
        localMessage: {
          ...preparing.preparation.localMessage,
          media: [source],
        },
        now: 2_500,
      })).toMatchObject({ state: "pending" });
      expect(store.preparingResourceCount(contact.id)).toBe(0);
      store.prune({ now: 10_000, receiptCutoff: 3_000, requestCutoff: 3_000, batchSize: 100 });
      expect(store.outbox(pending.deliveryId)?.state).toBe("pending");
      expect(store.outbox(preparing.deliveryId)?.state).toBe("pending");
      expect(store.outbox(settled.deliveryId)).toBeNull();
      expect(store.inviteByTokenHash("expired-token")).toBeNull();
    });
  });
});
