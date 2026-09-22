import { describe, expect, it, vi } from "vitest";
import { jsonObjectSchema, projectWork, type FederationWorkDelivery, type WorkRecord } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { FederationStore } from "../federation-store";
import { FederationIdentity } from "../federation-crypto";
import { ResponsibilityStore } from "../responsibility-store";
import { handleContactRequestCreate, handleContactRequestUpdate } from "../federation";
import { commitInboundWork, handleContactRequestAct } from "./work";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("participant-owned work admission", () => {
  it("does not duplicate an offer or responsibility when discovery overlaps an exact retry", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact } = fixture(storage);
      await ctx.federationIdentity.ensure("https://local.example");
      const args = { contactId: contact.id, kind: "task", title: "One offer", idempotencyKey: "concurrent:one" };
      const [first, second] = await Promise.all([handleContactRequestCreate(args, ctx), handleContactRequestCreate(args, ctx)]);
      expect(second.deliveryId).toBe(first.deliveryId);
      expect(second.request.id).toBe(first.request.id);
      expect(store.requestCount({ contactId: contact.id })).toBe(1);
      expect(ctx.responsibilities.getByDedupeKey(OWNER.uid, `federation.request:${contact.id}:${first.request.id}`)).not.toBeNull();
    });
  });

  it("commits statements, canonical offer and responsibility together and replays the same intent", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact } = fixture(storage);
      const sent = await handleContactRequestCreate({ contactId: contact.id, kind: "review", title: "Review the draft", details: { document: "original" }, idempotencyKey: "offer:one" }, ctx);
      expect(sent.request.work?.offer.reference.actor.subjectId).toBe(store.subject(OWNER.uid)?.id);
      const offered = sent.request.work!;
      expect(store.outbox(sent.deliveryId)).toMatchObject({ wireVersion: 2, payload: { kind: "work", operations: [] } });
      expect(await handleContactRequestCreate({ contactId: contact.id, kind: "review", title: "Review the draft", details: { document: "original" }, idempotencyKey: "offer:one" }, ctx)).toMatchObject({ deliveryId: sent.deliveryId });
      const accept: FederationWorkDelivery = { kind: "work", offer: offered.offer, participant: "performer", operations: [{ id: "remote:accept", revision: 1, action: "accept", observedPeerRevision: 0 }] };
      const withdrawalArgs = { requestId: sent.request.id, expectedRevision: 1, action: "withdraw" as const, idempotencyKey: "withdraw:one" };
      const withdraw = await handleContactRequestAct(withdrawalArgs, ctx);
      await deliver(accept, "delivery:accept", ctx, contact.id);
      const latest = store.request(sent.request.id)!;
      expect(projectWork(latest.work!)).toMatchObject({ status: "stop_requested", state: "accepted" });
      expect(latest.details).toEqual({ document: "original" });
      expect(await handleContactRequestAct(withdrawalArgs, ctx)).toMatchObject({ deliveryId: withdraw.deliveryId });
      const responsibility = ctx.responsibilities.getByDedupeKey(OWNER.uid, `federation.request:${contact.id}:${sent.request.id}`)!;
      expect(responsibility).toMatchObject({ state: "waiting", details: { workStatus: "stop_requested" } });
      await expect(handleContactRequestUpdate({ requestId: sent.request.id, state: "cancelled" }, ctx)).rejects.toThrow("contact.request.act");
      const reconcile = await handleContactRequestAct({ requestId: latest.id, expectedRevision: latest.revision, action: "reconcile", idempotencyKey: "sync:one" }, ctx);
      expect(reconcile.request.work).toEqual(latest.work);
      expect(reconcile.request.revision).toBe(latest.revision);
      const wrongOwner = { ...ctx, callerOwnerUid: 2000 };
      await expect(handleContactRequestAct({ requestId: latest.id, expectedRevision: latest.revision, action: "reconcile" }, wrongOwner)).rejects.toThrow("not found");
    });
  });

  it("repairs an absent offer from a full prefix without creating agent work and rejects rewritten offers atomically", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, store, contact } = fixture(storage);
      const work: WorkRecord = { offer: { reference: { actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, id: "request:remote" }, kind: "task", title: "Original offer", createdAtMs: Date.now() }, requester: [], performer: [] };
      const withdraw: FederationWorkDelivery = { kind: "work", offer: work.offer, participant: "requester", operations: [{ id: "remote:withdraw", revision: 1, action: "withdraw", observedPeerRevision: 0 }] };
      await deliver(withdraw, "delivery:withdraw-before-offer", ctx, contact.id);
      const request = store.requestForWork(contact.id, contact.generation, work.offer.reference.id, "incoming")!;
      expect(projectWork(request.work!).status).toBe("withdrawn");
      expect(ctx.responsibilities.getByDedupeKey(OWNER.uid, `federation.request:${contact.id}:${request.id}`)).toBeNull();
      await deliver({ ...withdraw, operations: [] }, "delivery:late-offer", ctx, contact.id);
      expect(store.request(request.id)?.work).toEqual(request.work);
      await expect(deliver({ ...withdraw, offer: { ...work.offer, title: "Changed offer" } }, "delivery:changed", ctx, contact.id)).rejects.toThrow("reused");
      await expect(deliver({ ...withdraw, offer: { ...work.offer, reference: { ...work.offer.reference, actor: { shipId: "ship:forged", subjectId: "subject:forged" } } } }, "delivery:forged", ctx, contact.id)).rejects.toThrow("origin");
      const cancel = await handleContactRequestAct({ requestId: request.id, expectedRevision: request.revision, action: "cancel", note: "No work was started" }, ctx);
      expect(cancel.request.state).toBe("cancelled");
      expect(ctx.responsibilities.getByDedupeKey(OWNER.uid, `federation.request:${contact.id}:${request.id}`)).toBeNull();
    });
  });
});

async function deliver(payload: FederationWorkDelivery, id: string, ctx: KernelContext, contactId: string) {
  const contact = ctx.federation.get(contactId)!;
  const inbox = ctx.federation.receive({ contactId, contactGeneration: contact.generation, deliveryId: id,
    payloadHash: JSON.stringify(payload), payload, wireVersion: 2, now: Date.now() }).record;
  await commitInboundWork(payload, inbox, contact, ctx);
  ctx.federation.commitInbox(contactId, contact.generation, id, jsonObjectSchema.parse({ delivered: true }), Date.now());
}

function fixture(storage: DurableObjectStorage) {
  const store = new FederationStore(storage);
  store.ensureSubject(OWNER.uid, "Person");
  const contact = store.activateContact({ ownerUid: OWNER.uid, remoteShipId: "ship:remote", remoteSubject: { id: "subject:remote", displayName: "Remote" },
    remoteOrigin: "https://remote.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "secret", generation: "generation:one", threadId: "thread:one" });
  store.setProtocol(contact.id, contact.generation, { version: 2, features: ["messages", "work"], checkedAtMs: Date.now() });
  const context = { peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*"] }), callerOwnerUid: OWNER.uid,
    connection: {}, federation: store, federationIdentity: new FederationIdentity(storage), responsibilities: new ResponsibilityStore(storage),
    installationIdentity: { canonicalOrigin: "https://local.example" },
    broadcastToUserUid: vi.fn(), scheduleFederationDelivery: vi.fn(async () => {}), reconcileResponsibilityWake: vi.fn(async () => {}),
    auth: { getPasswdByUid: () => OWNER } };
  // SAFETY: real owning stores; only scheduling and the already-authenticated account boundary are stubbed.
  return { ctx: context as KernelContext, store, contact };
}
