import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, JsonObject, OriginMessageRef, ResourceBlock, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import * as sharedUtils from "../../shared/utils";
import { spyOnProcessDeliveries } from "../../test-support/process-deliveries";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { shipConsumer } from "../events/consumers";
import { isWithdrawn, type ProcessEventDelivery } from "../events/registry";
import { EventRuntime, type EventRuntimeHost } from "../events/runtime";
import { EventStore, type LoggedEvent } from "../events/store";
import { FederationStore, type FederationContactRecord, type FederationOutboxLocalMessage } from "../federation-store";
import * as personalController from "../personal-controller";
import { ResponsibilityStore } from "../responsibility-store";
import { OwnerNoticeStore } from "../owner-notice-store";
import { admitContactMessage, bindContactReply, contactMessageEvent, endContactHandling } from "./attention";
import { handleContactPreferencesUpdate } from "./preferences";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };
const LOCAL_DID = "did:plc:localaaaaaaaaaaaaaaaaaaa";
const REMOTE_DID = "did:plc:remoteaaaaaaaaaaaaaaaaaa";
const HUMAN = { kind: "account", uid: OWNER.uid, username: OWNER.username } as const;

afterEach(() => vi.restoreAllMocks());

describe("contact attention admission", () => {
  it.each(["human", "process"] as const)("keeps an accepted contact and new %s messages in People until handed over", async (kind) => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const incoming = receive(contact, ctx, kind);
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(false);
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(false);
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toEqual([]);
    });
  });

  it("tells the person's messenger about each message they handle, once", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const first = receive(contact, ctx, "human");
      const second = receive(contact, ctx, "human", undefined, 2);
      expect(admitContactMessage(contact, first.inbox, first.message, ctx)).toBe(false);
      expect(admitContactMessage(contact, first.inbox, first.message, ctx)).toBe(false);
      expect(admitContactMessage(contact, second.inbox, second.message, ctx)).toBe(false);
      expect(ctx.ownerNotices.next(OWNER.uid)).toMatchObject({
        topic: "contact.message", pendingCount: 2,
        subject: { contactId: contact.id, contactGeneration: contact.generation, conversationId: contact.conversationId, from: "Remote", preview: "Friday works" },
      });
      expect(queued(ctx, contact)).toEqual([]);
    });
  });

  it("sends no notice for a muted contact or one Ship handles", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { muted: true } }, ctx);
      const quiet = receive(contact, ctx, "human");
      admitContactMessage(ctx.federation.get(contact.id)!, quiet.inbox, quiet.message, ctx);
      expect(ctx.ownerNotices.next(OWNER.uid)).toBeNull();

      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { muted: false, shipHandlesMessages: true } }, ctx);
      const handled = receive(contact, ctx, "human", undefined, 2);
      expect(admitContactMessage(ctx.federation.get(contact.id)!, handled.inbox, handled.message, ctx)).toBe(true);
      expect(ctx.ownerNotices.next(OWNER.uid)).toBeNull();
    });
  });

  it("appends each handled message as its own event, naming its Conversation message, without rewriting or waking the ledger", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const photo = receive(contact, ctx, "human");
      const caption = receive(contact, ctx, "human", undefined, 2);
      expect(admitContactMessage(contact, photo.inbox, photo.message, ctx)).toBe(true);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      // The title carries the contact's own display name, so the record is marked as outside text.
      expect(work).toMatchObject({ title: "Pending messages from Remote", state: "open", assignee: { kind: "ship" }, details: { contentTrust: "untrusted" } });
      expect(admitContactMessage(contact, caption.inbox, caption.message, ctx)).toBe(true);
      expect(ctx.responsibilities.get(OWNER.uid, work.id)?.revision).toBe(work.revision);
      expect(ctx.responsibilities.takeReadyBatch(OWNER.uid, Date.now())).toBeNull();

      const [first, second] = queued(ctx, contact);
      expect(first).toMatchObject({ consumer: shipConsumer(OWNER.uid), lane: "background", event: {
        type: "contact.message", ownerUid: OWNER.uid, subject: contact.id, key: photo.message.id,
        actor: { kind: "contact", contactId: contact.id },
        body: {
          contactId: contact.id, contactGeneration: contact.generation, conversationId: contact.conversationId,
          sequence: 1, messageId: photo.message.id, responsibilityId: work.id, ledgerRevision: ctx.responsibilities.revision(OWNER.uid),
        },
      } });
      // The Conversation keeps the words and attachments; the event only names them.
      expect(first!.event.body).not.toHaveProperty("text");
      expect(second!.event).toMatchObject({ key: caption.message.id, body: { sequence: 2 } });
    });
  });

  it("delivers a handled message to Ship as it reads in its Conversation", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const incoming = receive(contact, ctx, "human");
      const photo = attachment("photo.jpg");
      const stored = { ...incoming.message, text: "Friday works, see the photo", media: [photo] };
      const read = readable(stored);
      admitContactMessage(contact, incoming.inbox, incoming.message, ctx);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      const admittedAt = ctx.responsibilities.revision(OWNER.uid);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = spyOnProcessDeliveries((installationId) => installationId === "installation:test", async (_installation, _pid, args) => (
        { eventId: args.eventId, runId: args.eventId, queued: false }
      ));
      const runner = runtime(storage, ctx);

      await runner.onEvents({ id: "task:contact" });

      expect(read).toHaveBeenCalledExactlyOnceWith({ sequence: 1, messageId: incoming.message.id });
      const [event] = storage.sql.exec<{ seq: number }>("SELECT seq FROM events").toArray();
      expect(deliver).toHaveBeenCalledExactlyOnceWith("installation:test", "proc:ship", {
        eventId: `evt_${event!.seq}:${shipConsumer(OWNER.uid)}`,
        event: {
          kind: "contact.message", severity: "info", audience: "model",
          payload: {
            contactId: contact.id, conversationId: contact.conversationId, messageId: incoming.message.id,
            from: "Remote", text: "Friday works, see the photo", responsibilityId: work.id,
          },
        },
        admission: { idle: "start", busy: "join" },
        responsibilities: { ledgerRevision: admittedAt, ids: [work.id] },
        attachments: [photo],
      });
      expect(queued(ctx, contact)).toEqual([]);
      // Ship owes this work a run; the ledger now recovers it if that run never settles it.
      expect(ctx.responsibilities.nextWakeAt(OWNER.uid, Date.now())).toBeGreaterThan(Date.now());
    });
  });

  it("starts its work's recovery wakes over when the contact writes again", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const first = receive(contact, ctx, "human");
      admitContactMessage(contact, first.inbox, first.message, ctx);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      // Ship left the work untouched through three recovery wakes, so the next would be 6 h away.
      storage.sql.exec("UPDATE responsibilities SET wake_retry_count = 3 WHERE responsibility_id = ?", work.id);
      const second = receive(contact, ctx, "human", undefined, 2);
      admitContactMessage(contact, second.inbox, second.message, ctx);
      readable(second.message);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      vi.spyOn(sharedUtils, "deliverEventToProcess").mockImplementation(async (_installation, _pid, args) => (
        { eventId: args.eventId, runId: args.eventId, queued: false }
      ));

      const deliveredFrom = Date.now();
      await runtime(storage, ctx).onEvents({ id: "task:again" });

      expect(queued(ctx, contact)).toEqual([]);
      const recoveryAt = ctx.responsibilities.nextWakeAt(OWNER.uid, Date.now())!;
      expect(recoveryAt).toBeGreaterThanOrEqual(deliveredFrom + 5 * 60_000);
      expect(recoveryAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });
  });

  it("withdraws a message its Conversation no longer has, and delivers one queued before the event log from its stored words", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const incoming = receive(contact, ctx, "human");
      admitContactMessage(contact, incoming.inbox, incoming.message, ctx);
      const [pending] = queued(ctx, contact);
      const read = readable(null);
      expect(await contactMessageEvent.prepare!(pending!.event, ctx)).toEqual({ withdrawn: "the message is no longer in its conversation" });

      const photo = attachment("photo.jpg");
      const { sequence: _sequence, ...reference } = body(pending!.event);
      const legacy = { ...pending!.event, body: { ...reference, from: "Remote", text: "stored words", media: [photo] } };
      read.mockClear();
      expect(await contactMessageEvent.prepare!(legacy, ctx)).toEqual({ text: "stored words", attachments: [photo] });
      expect(read).not.toHaveBeenCalled();
    });
  });

  it("moves a queued message past resolved handling, but withdraws it once the person takes over", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const first = receive(contact, ctx, "human");
      const second = receive(contact, ctx, "human", undefined, 2);
      admitContactMessage(contact, first.inbox, first.message, ctx);
      admitContactMessage(contact, second.inbox, second.message, ctx);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      ctx.responsibilities.update({ ownerUid: OWNER.uid, id: work.id, patch: { state: "resolved" }, actor: HUMAN, observedByShip: true, now: Date.now() });

      const [pending] = queued(ctx, contact);
      expect(contactMessageEvent.withdrawal!(pending!.event, ctx)).toBeNull();
      const rebound = admitted(contactMessageEvent.admit(pending!.event, { text: "Friday works", attachments: [] }, ctx));
      const [fresh] = rebound.responsibilities!.ids;
      expect(fresh).not.toBe(work.id);
      expect(ctx.responsibilities.get(OWNER.uid, fresh!)).toMatchObject({ state: "open", assignee: { kind: "ship" } });
      expect(rebound.event).toMatchObject({ payload: { responsibilityId: fresh } });

      // Both messages still wait for Ship; taking over withdraws them, even once Ship has them back.
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { shipHandlesMessages: false } }, ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 3, patch: { shipHandlesMessages: true } }, ctx);
      expect(queued(ctx, contact)).toEqual([]);
    });
  });

  it("withdraws a queued message from an earlier contact generation, a blocked contact or cancelled work", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const incoming = receive(contact, ctx, "human");
      admitContactMessage(contact, incoming.inbox, incoming.message, ctx);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      const [pending] = queued(ctx, contact);
      const event = pending!.event;
      expect(contactMessageEvent.withdrawal!({ ...event, body: { ...body(event), contactGeneration: "generation:zero" } }, ctx))
        .toBe("the contact relationship changed");
      ctx.federation.setBlock(OWNER.uid, REMOTE_DID, true);
      expect(contactMessageEvent.withdrawal!(event, ctx)).toBe("the contact is blocked");
      ctx.federation.setBlock(OWNER.uid, REMOTE_DID, false);
      ctx.responsibilities.update({ ownerUid: OWNER.uid, id: work.id, patch: { state: "cancelled" },
        actor: HUMAN, observedByShip: true, now: Date.now() });
      expect(contactMessageEvent.withdrawal!(event, ctx)).toBe("Ship no longer handles the message");
    });
  });

  it("enables future replies without waking Ship or replaying previous messages", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const earlier = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, earlier.inbox, earlier.message, ctx)).toBe(false);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      expect(ctx.federation.get(contact.id)?.preferences.shipHandlesMessages).toBe(true);
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "contact.changed");
      expect(admitContactMessage(contact, earlier.inbox, earlier.message, ctx)).toBe(false);
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toEqual([]);
    });
  });

  it.each(["revoked", "blocked"] as const)("cannot enable replies for a %s contact", async (state) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      if (state === "revoked") ctx.federation.revoke(contact.id, OWNER.uid);
      else ctx.federation.setBlock(OWNER.uid, REMOTE_DID, true);
      const revision = ctx.federation.get(contact.id)!.preferences.revision;
      await expect(handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: revision, patch: { shipHandlesMessages: true } }, ctx))
        .rejects.toThrow("Only an active contact");
      expect(ctx.federation.get(contact.id)?.preferences).toMatchObject({ revision, shipHandlesMessages: false });
      expect(ctx.reconcileResponsibilityWake).not.toHaveBeenCalled();
    });
  });

  it("reuses one responsibility across new messages, suppresses duplicates, and stops when replies are disabled", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const initial = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, initial.inbox, initial.message, ctx)).toBe(true);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      expect(work.assignee).toEqual({ kind: "ship" });
      for (const kind of ["human", "process"] as const) {
        waiting(work, ctx);
        const incoming = receive(contact, ctx, kind);
        expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
        const updated = ctx.responsibilities.get(OWNER.uid, work.id)!;
        expect(updated.state).toBe("open");
        expect(updated.details).toEqual(work.details);
        expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(false);
        expect(ctx.responsibilities.get(OWNER.uid, work.id)?.revision).toBe(updated.revision);
      }
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid, includeTerminal: true }).records).toHaveLength(1);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { shipHandlesMessages: false } }, ctx);
      expect(ctx.responsibilities.get(OWNER.uid, work.id)?.state).toBe("cancelled");
      const later = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, later.inbox, later.message, ctx)).toBe(false);
    });
  });

  it.each(["human", "process"] as const)("continues a task for a %s reply without enabling permanent handling", async (kind) => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const work = task(ctx);
      const sent = outgoing(contact);
      bindContactReply(contact, sent, work.id, ctx);
      const incoming = receive(contact, ctx, kind);
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
      expect(ctx.responsibilities.get(OWNER.uid, work.id)).toMatchObject({ state: "open", title: work.title });
      expect(ctx.federation.get(contact.id)?.preferences.shipHandlesMessages).toBe(false);
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid }).records).toHaveLength(1);

      ctx.responsibilities.update({ ownerUid: OWNER.uid, id: work.id, patch: { state: "resolved" }, actor: HUMAN, observedByShip: true, now: Date.now() });
      const afterCompletion = receive(contact, ctx, kind, sent.social!.reference);
      expect(admitContactMessage(contact, afterCompletion.inbox, afterCompletion.message, ctx)).toBe(false);
      ctx.federation.pruneReplyWaits();
      expect(ctx.federation.replyResponsibilities(contact)).toEqual([]);
    });
  });

  it("waits for a new message to create work after replies are re-enabled", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const initial = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, initial.inbox, initial.message, ctx)).toBe(true);
      const first = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { shipHandlesMessages: false } }, ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 3, patch: { shipHandlesMessages: true } }, ctx);
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid }).records).toEqual([]);
      expect(admitContactMessage(contact, initial.inbox, initial.message, ctx)).toBe(false);
      const incoming = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
      const active = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records;
      expect(active).toHaveLength(1);
      expect(active[0]!.id).not.toBe(first.id);
      expect(ctx.responsibilities.get(OWNER.uid, first.id)?.state).toBe("cancelled");
      const later = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, later.inbox, later.message, ctx)).toBe(true);
      expect(ctx.responsibilities.list({ ownerUid: OWNER.uid }).records.map((work) => work.id)).toEqual([active[0]!.id]);
      expect(endContactHandling(contact, ctx)).toBe(true);
      expect(ctx.responsibilities.get(OWNER.uid, active[0]!.id)?.state).toBe("cancelled");
    });
  });

  it("keeps completed handoffs terminal when another message arrives", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const initial = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, initial.inbox, initial.message, ctx)).toBe(true);
      const first = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      ctx.responsibilities.update({ ownerUid: OWNER.uid, id: first.id, patch: { state: "resolved" }, actor: HUMAN, observedByShip: true, now: Date.now() });
      const incoming = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(false);
      const active = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records;
      expect(active).toHaveLength(1);
      expect(active[0]!.id).not.toBe(first.id);
      expect(ctx.responsibilities.get(OWNER.uid, first.id)?.state).toBe("resolved");
    });
  });

  it("requires an exact reply reference when several tasks await the same contact", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const first = task(ctx);
      const second = task(ctx);
      const firstMessage = outgoing(contact);
      const secondMessage = outgoing(contact);
      bindContactReply(contact, firstMessage, first.id, ctx);
      bindContactReply(contact, secondMessage, second.id, ctx);
      const ambiguous = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, ambiguous.inbox, ambiguous.message, ctx)).toBe(false);
      const forged = receive(contact, ctx, "process", { did: REMOTE_DID, messageId: secondMessage.social!.reference.messageId });
      expect(admitContactMessage(contact, forged.inbox, forged.message, ctx)).toBe(false);
      const precise = receive(contact, ctx, "process", secondMessage.social!.reference);
      expect(admitContactMessage(contact, precise.inbox, precise.message, ctx)).toBe(true);
      expect(ctx.responsibilities.get(OWNER.uid, second.id)?.state).toBe("open");
      expect(ctx.responsibilities.get(OWNER.uid, first.id)?.state).toBe("waiting");
    });
  });

  it("keeps task reply waits when taking back new messages, and ends them when the relationship ends", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const work = task(ctx);
      bindContactReply(contact, outgoing(contact), work.id, ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { shipHandlesMessages: false } }, ctx);
      expect(ctx.federation.replyResponsibilities(contact)).toEqual([work.id]);
      expect(endContactHandling(contact, ctx)).toBe(true);
      expect(ctx.federation.replyResponsibilities(contact)).toEqual([]);
      expect(ctx.responsibilities.get(OWNER.uid, work.id)).toMatchObject({ state: "open", details: { contactDisconnected: { contactId: contact.id } } });
      const nextGeneration = ctx.federation.activateContact({ ownerUid: OWNER.uid, remoteDid: REMOTE_DID, remoteName: "Remote",
        generation: "generation:next", threadId: contact.threadId, now: Date.now() });
      const later = receive(nextGeneration, ctx, "human");
      expect(admitContactMessage(nextGeneration, later.inbox, later.message, ctx)).toBe(false);
    });
  });

  it("allows only the owner or Ship to bind owned, active Ship work", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      const work = task(ctx);
      expect(() => bindContactReply(contact, outgoing(contact), work.id, { ...ctx, processId: "proc:crew" })).toThrow("signed-in human or their Ship");
      const foreign = task(ctx, 1001);
      expect(() => bindContactReply(contact, outgoing(contact), foreign.id, ctx)).toThrow("not found");
      bindContactReply(contact, outgoing(contact), work.id, { ...ctx, processId: "proc:ship" });
      ctx.responsibilities.update({ ownerUid: OWNER.uid, id: work.id, patch: { state: "resolved" }, actor: HUMAN, observedByShip: true, now: Date.now() });
      expect(() => bindContactReply(contact, outgoing(contact), work.id, ctx)).toThrow("open Ship responsibility");
    });
  });
});

function context(storage: DurableObjectStorage): KernelContext {
  const events = new EventStore(storage);
  // SAFETY: producers reach only the runtime's append and its store queries.
  const runner = new EventRuntime({ events } as EventRuntimeHost);
  const result = {
    installationId: "installation:test",
    federation: new FederationStore(storage), responsibilities: new ResponsibilityStore(storage), events: runner,
    ownerNotices: new OwnerNoticeStore(storage),
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*", "r12y.*"] }),
    callerOwnerUid: OWNER.uid, connection: {},
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    procs: { get: (id: string) => ({ ownerUid: OWNER.uid, isPersonalController: id === "proc:ship" }) },
    coordinateFederationContact: async <T>(_id: string, operation: () => T | Promise<T>) => operation(),
    reconcileResponsibilityWake: vi.fn(async () => {}), broadcastToUserUid: vi.fn(),
    shipIdentity: { current: () => LOCAL_DID },
  };
  // SAFETY: the handlers use these real stores and the explicit caller, account and scheduling callbacks.
  return result as KernelContext;
}

function activate(ctx: KernelContext): FederationContactRecord {
  return ctx.federation.activateContact({ ownerUid: OWNER.uid, remoteDid: REMOTE_DID, remoteName: "Remote",
    generation: "generation:one", threadId: "thread:one" });
}

function task(ctx: KernelContext, ownerUid = OWNER.uid): ResponsibilityRecord {
  return ctx.responsibilities.create({ ownerUid, title: "Ask about Friday", assignee: { kind: "ship" },
    source: HUMAN, actor: HUMAN, state: "waiting", blocker: "Awaiting the contact", priority: "normal", observedByShip: true, now: Date.now() }).record;
}

function waiting(work: ResponsibilityRecord, ctx: KernelContext): void {
  ctx.responsibilities.update({ ownerUid: OWNER.uid, id: work.id, patch: { state: "waiting", blocker: "Awaiting a reply" },
    actor: HUMAN, observedByShip: true, now: Date.now() });
}

function outgoing(contact: FederationContactRecord): FederationOutboxLocalMessage {
  const messageId = `msg:${crypto.randomUUID()}`;
  return { messageId, text: "Friday?", author: { kind: "user", uid: OWNER.uid }, origin: { kind: "user" }, createdAtMs: Date.now(),
    social: { threadId: contact.threadId, reference: { did: LOCAL_DID, messageId }, provenance: { kind: "human" } } };
}

function receive(contact: FederationContactRecord, ctx: KernelContext, kind: "human" | "process", replyTo?: OriginMessageRef, sequence = 1) {
  const messageId = `msg:${crypto.randomUUID()}`;
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const social = { threadId: contact.threadId, reference: { did: REMOTE_DID, messageId },
    provenance: kind === "human" ? { kind: "human" as const } : { kind: "process" as const, processId: "proc:remote" }, ...(replyTo ? { replyTo } : undefined) };
  const inbox = ctx.federation.receive({ contactId: contact.id, contactGeneration: contact.generation, deliveryId,
    payload: { kind: "message", messageId, threadId: contact.threadId, text: "Friday works", social }, payloadHash: messageId }).record;
  const message: ConversationMessage = { id: messageId, sequence, conversationId: contact.conversationId, text: "Friday works", social,
    author: { kind: "contact", contactId: contact.id, displayName: "Remote" },
    origin: { kind: "federation", contactId: contact.id, deliveryId }, createdAt: Date.now() };
  return { inbox, message };
}

/** A runner over the same log, delivering through the real registry with this context. */
function runtime(storage: DurableObjectStorage, ctx: KernelContext): EventRuntime {
  const host = {
    installationId: "installation:test",
    events: new EventStore(storage),
    responsibilities: ctx.responsibilities,
    auth: { isAccountDisabled: (_uid: number) => false },
    procs: { get: (_pid: string) => null },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
    buildKernelContext: () => ctx,
    schedule: vi.fn(async (when: Date, _callback: string, _payload: null, _options: DurableTaskOptions) =>
      ({ id: `task:${when.getTime()}`, time: Math.floor(when.getTime() / 1_000) })),
    cancelSchedule: vi.fn(async (_id: string) => true),
  };
  // SAFETY: EventRuntime reaches only these Kernel members.
  return new EventRuntime(host as EventRuntimeHost);
}

function queued(ctx: KernelContext, contact: FederationContactRecord) {
  return ctx.events.pending("contact.message", contact.id);
}

function body(event: LoggedEvent): JsonObject {
  // SAFETY: a contact message's body is always an object.
  return event.body as JsonObject;
}

function admitted(delivery: ProcessEventDelivery | { withdrawn: string }): ProcessEventDelivery {
  if (isWithdrawn(delivery)) throw new Error(`Delivery was withdrawn: ${delivery.withdrawn}`);
  return delivery;
}

/** Answers Conversation reads with this message, or with nothing. */
function readable(message: ConversationMessage | null) {
  const readMessage = vi.fn(async (_input: { sequence: number; messageId: string }) => message);
  // SAFETY: delivery reads a contact message through readMessage alone.
  vi.spyOn(sharedUtils, "getConversationById").mockReturnValue({ readMessage } as ReturnType<typeof sharedUtils.getConversationById>);
  return readMessage;
}

function attachment(filename: string): ResourceBlock {
  return { type: "resource", filename,
    ref: { type: "file", target: "contact:remote", path: `/resources/${filename}`, revision: "r1", contentType: "image/jpeg", size: 10 } };
}
