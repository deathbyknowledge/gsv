import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ContactRequestRecord, FederationMessageDelivery } from "@humansandmachines/gsv/protocol";
import { getDurableObjectByName } from "../shared/durable-object";
import type { Kernel } from "./do";
import { FederationStore } from "./federation-store";

const REMOTE_DID = "did:plc:remoteaaaaaaaaaaaaaaaaaa";
const LOCAL_DID = "did:plc:localaaaaaaaaaaaaaaaaaaa";

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
  return store.activateContact({
    ownerUid: 1000,
    remoteDid: REMOTE_DID,
    remoteName: "Remote person",
    remoteHandle: "remote.ship.test",
    generation: "generation:first",
    threadId: "thread:first",
    now: 1_000,
  });
}

/** A message this Ship's person wrote, as a delivery carries it. */
function message(messageId: string, threadId: string, text: string): FederationMessageDelivery {
  return {
    kind: "message", messageId, threadId, text,
    social: { threadId, reference: { did: LOCAL_DID, messageId }, provenance: { kind: "human" } },
  };
}

describe("FederationStore", () => {
  it.each(["revoke", "reconnect"] as const)("ends pending terminal request confirmation on %s", async (operation) => {
    await withStore((store) => {
      const contact = activateContact(store);
      store.createRequest({
        id: "request:completed", remoteId: "request:remote", contactId: contact.id,
        contactGeneration: contact.generation, direction: "incoming", kind: "task", title: "Work",
        state: "completed", exchange: { state: "pending", source: "local", deliveryId: "delivery:complete" },
        createdAtMs: 1_000, updatedAtMs: 2_000,
      });
      if (operation === "revoke") store.revoke(contact.id, contact.ownerUid, 3_000);
      else store.activateContact({
        ownerUid: contact.ownerUid, remoteDid: REMOTE_DID, remoteName: contact.remoteName,
        generation: "generation:replacement", threadId: "thread:replacement", now: 3_000,
      });
      expect(store.request("request:completed")).toMatchObject({
        state: "completed", revision: 1,
        exchange: { state: "failed", deliveryId: "delivery:complete", lastError: expect.stringContaining("Contact") },
      });
    });
  });

  it("preserves private preferences across re-pairing and rejects stale or foreign edits", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      expect(contact.preferences).toEqual({ saved: true, muted: false, shipHandlesMessages: false, revision: 1 });
      const updated = store.updatePreferences(contact.ownerUid, {
        contactId: contact.id, expectedRevision: 1, patch: { saved: false, muted: true, shipHandlesMessages: true },
      });
      expect(updated.preferences).toEqual({ saved: false, muted: true, shipHandlesMessages: true, revision: 2 });
      expect(updated.state).toBe("active");
      expect(updated.conversationId).toBe(contact.conversationId);
      expect(() => store.updatePreferences(contact.ownerUid, { contactId: contact.id, expectedRevision: 1, patch: { saved: true } })).toThrow("preferences changed");
      expect(() => store.updatePreferences(2000, { contactId: contact.id, expectedRevision: 2, patch: { muted: false } })).toThrow("Contact not found");
      const replacement = store.activateContact({
        ownerUid: contact.ownerUid, remoteDid: REMOTE_DID, remoteName: contact.remoteName,
        generation: "generation:replacement", threadId: "thread:replacement",
      });
      expect(replacement.preferences).toEqual({ saved: false, muted: true, shipHandlesMessages: false, revision: 3 });
      expect(replacement.conversationId).toBe(contact.conversationId);
    });
  });

  it("keeps blocks independent of generations and paginates them within one owner", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      store.transaction(() => {
        store.setBlock(contact.ownerUid, REMOTE_DID, true, 10);
        store.revoke(contact.id, contact.ownerUid, 10);
      });
      expect(store.setBlock(contact.ownerUid, REMOTE_DID, true, 20)).toMatchObject({ changed: false, block: { createdAtMs: 10 } });
      expect(() => store.activateContact({
        ownerUid: contact.ownerUid, remoteDid: REMOTE_DID, remoteName: "Remote person, again",
        generation: "generation:new", threadId: "thread:new",
      })).toThrow("pairing is unavailable");
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: true });
      const another = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
      store.setBlock(contact.ownerUid, another, true, 30);
      store.setBlock(2000, REMOTE_DID, true, 40);
      const page = store.listBlocks(contact.ownerUid, 1);
      expect(page.blocks).toEqual([{ did: REMOTE_DID, createdAtMs: 10 }]);
      expect(store.listBlocks(contact.ownerUid, 1, page.nextCursor)).toEqual({ blocks: [{ did: another, createdAtMs: 30 }] });
      store.setBlock(contact.ownerUid, REMOTE_DID, false);
      expect(store.get(contact.id)).toMatchObject({ state: "revoked", blocked: false });
      expect(store.isBlocked(2000, REMOTE_DID)).toBe(true);
    });
  });

  it("retains unsettled request outcomes beyond delivery retention and fences late receipts", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      const delivery = store.enqueue({
        deliveryId: "delivery:complete", ownerUid: contact.ownerUid, contactId: contact.id,
        contactGeneration: contact.generation, idempotencyKey: "complete", fingerprint: "complete",
        payload: { kind: "request.update", requestId: "request:remote", expectedRevision: 2, state: "completed" },
        now: 2_000,
      }).record;
      const request = store.createRequest({
        id: "request:local", remoteId: "request:remote", contactId: contact.id,
        contactGeneration: contact.generation, direction: "incoming", kind: "task", title: "Work",
        state: "completed", exchange: { state: "pending", source: "local", deliveryId: delivery.deliveryId },
        createdAtMs: 1_000, updatedAtMs: 2_000,
      });
      expect(store.listRequests(contact.ownerUid, contact.id)).toEqual([request]);
      store.settleRequestDelivery({ ...delivery, state: "terminal", lastError: "Remote rejected the revision" });
      store.markOutboxFailed(delivery.deliveryId, contact.generation, "pending", "Remote rejected the revision", null, true, 3_000);
      store.prune({ now: 10_000, receiptCutoff: 4_000, requestCutoff: 0, batchSize: 100 });
      expect(store.outbox(delivery.deliveryId)).toBeNull();
      expect(store.request(request.id)?.exchange).toEqual({
        state: "failed", source: "local", deliveryId: delivery.deliveryId, lastError: "Remote rejected the revision",
      });
      expect(store.listRequests(contact.ownerUid, contact.id)).toHaveLength(1);

      store.updateRequest({
        requestId: request.id, expectedRevision: 1, state: "cancelled", updatedAtMs: 11_000,
        exchange: { state: "acknowledged" },
      });
      expect(store.settleRequestDelivery({ ...delivery, state: "delivered" })).toBeNull();
      expect(store.request(request.id)).toMatchObject({
        state: "cancelled", revision: 2, exchange: { state: "acknowledged" },
      });
      expect(store.listRequests(contact.ownerUid, contact.id)).toEqual([]);
    });
  });

  it("keeps a local alias separate from refreshed remote identity", async () => {
    await withStore((store) => {
      const contact = activateContact(store);
      expect(store.setAlias(contact.id, 1000, "Flynn", 1_100)).toMatchObject({
        localAlias: "Flynn",
        remoteName: "Remote person",
      });

      const reconnected = store.activateContact({
        ownerUid: 1000,
        remoteDid: REMOTE_DID,
        remoteName: "Remote person renamed",
        generation: "generation:second",
        threadId: "thread:second",
        now: 1_200,
      });
      expect(reconnected).toMatchObject({ localAlias: "Flynn", remoteName: "Remote person renamed" });
      // A handle shows only while it names the DID back; reconnecting without one clears the old.
      expect(reconnected.remoteHandle).toBeUndefined();
      expect(store.setAlias(contact.id, 1000, null, 1_300).localAlias).toBeUndefined();
    });
  });

  it("lists invitation metadata and records explicit cancellation", async () => {
    await withStore((store) => {
      const pending = store.createInvite({
        ownerUid: 1000,
        tokenHash: "pending-token",
        expiresAtMs: 20_000,
        now: 1_000,
      });
      store.createInvite({
        ownerUid: 2000,
        tokenHash: "other-owner-token",
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
        expiresAtMs: 20_000,
        now: 1_000,
      });
      expect(store.acceptInvite({
        tokenHash: consumable.tokenHash,
        remoteDid: REMOTE_DID,
        contactId: "contact:accepted",
        generation: "generation:accepted",
        threadId: "thread:accepted",
        now: 2_000,
      })).toBe(true);
      expect(store.acceptInvite({
        tokenHash: consumable.tokenHash,
        remoteDid: "did:plc:otheraaaaaaaaaaaaaaaaaaa",
        contactId: "contact:other",
        generation: "generation:other",
        threadId: "thread:other",
        now: 3_000,
      })).toBe(false);
      expect(store.invite(consumable.inviteId)).toMatchObject({
        state: "accepted",
        acceptedContactId: "contact:accepted",
        acceptedRemoteDid: REMOTE_DID,
        acceptedGeneration: "generation:accepted",
        acceptedThreadId: "thread:accepted",
      });
    });
  });

  it("persists one current pairing attempt before it can commit a contact", async () => {
    await withStore((store) => {
      const firstInput = {
        shipHandlesMessages: true,
        tokenHash: "pairing:first",
        ownerUid: 1000,
        expiresAtMs: 20_000,
        remoteDid: REMOTE_DID,
        now: 1_000,
      };
      expect(store.beginPairingAttempt(firstInput)).toMatchObject({
        shipHandlesMessages: true,
        state: "pending",
        tokenHash: firstInput.tokenHash,
        remoteDid: REMOTE_DID,
      });
      expect(() => store.beginPairingAttempt({ ...firstInput, shipHandlesMessages: false })).toThrow("different handling choice");
      expect(store.beginPairingAttempt({ ...firstInput, shipHandlesMessages: undefined }).shipHandlesMessages).toBe(true);
      expect(() => store.beginPairingAttempt({
        ...firstInput,
        remoteDid: "did:plc:changedaaaaaaaaaaaaaaaaa",
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
        payload: message("message:pending-before-revoke", contact.threadId, "Pending before revocation"),
        now: 1_100,
      }).record;
      const revocation = store.receive({
        contactId: contact.id,
        contactGeneration: contact.generation,
        deliveryId: "delivery:revoke",
        payloadHash: "hash:revoke",
        payload: { kind: "contact.revoked" },
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
        payload: message("message:old-generation", contact.threadId, "Pending before re-pairing"),
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
        payload: message("message:received-old-generation", contact.threadId, "Admitted before re-pairing"),
        now: 1_100,
      }).record;

      const replacement = store.transaction(() => store.activateContact({
        ownerUid: contact.ownerUid,
        remoteDid: REMOTE_DID,
        remoteName: contact.remoteName,
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
        payload: message("message:first", contact.threadId, "Hello"),
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
        payload: message("message:first-generation", first.threadId, "First generation"),
        now: 1_100,
      });
      const second = store.activateContact({
        ownerUid: first.ownerUid,
        remoteDid: REMOTE_DID,
        remoteName: first.remoteName,
        generation: "generation:second",
        threadId: "thread:second",
        now: 2_000,
      });
      const admitted = store.receive({
        contactId: second.id,
        contactGeneration: second.generation,
        deliveryId,
        payloadHash: "hash:second-generation",
        payload: message("message:second-generation", second.threadId, "Second generation"),
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
        payload: message("message:pending", contact.threadId, "Pending"),
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
        payload: message("message:settled", contact.threadId, "Settled"),
        now: 1_000,
      }).record;
      store.markDeliverySucceeded(settled.deliveryId, settled.contactGeneration, 2_000);
      store.createInvite({
        ownerUid: 1000,
        tokenHash: "expired-token",
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
          social: { threadId: preparing.preparation.threadId, reference: { did: LOCAL_DID, messageId: preparing.preparation.messageId }, provenance: { kind: "human" } },
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
