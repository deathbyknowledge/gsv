import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage, OriginMessageRef, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { FederationStore, type FederationContactRecord, type FederationOutboxLocalMessage } from "../federation-store";
import { ResponsibilityStore } from "../responsibility-store";
import { admitContactMessage, bindContactReply, endContactHandling } from "./attention";
import { handleContactPreferencesUpdate } from "./preferences";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };
const LOCAL = { shipId: "ship:local", subjectId: "subject:local" };
const HUMAN = { kind: "account", uid: OWNER.uid, username: OWNER.username } as const;

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

  it("reuses one handoff across messages, suppresses duplicates, and lets the person take it back", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const work = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      expect(work.assignee).toEqual({ kind: "ship" });
      for (const kind of ["human", "process"] as const) {
        waiting(work, ctx);
        const incoming = receive(contact, ctx, kind);
        expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
        const updated = ctx.responsibilities.get(OWNER.uid, work.id)!;
        expect(updated).toMatchObject({ state: "open", details: { contactReply: { messageId: incoming.message.id, provenance: kind } } });
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

  it("creates a fresh handoff when handling is enabled again", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = context(storage);
      const contact = activate(ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 1, patch: { shipHandlesMessages: true } }, ctx);
      const first = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records[0]!;
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 2, patch: { shipHandlesMessages: false } }, ctx);
      await handleContactPreferencesUpdate({ contactId: contact.id, expectedRevision: 3, patch: { shipHandlesMessages: true } }, ctx);
      const active = ctx.responsibilities.list({ ownerUid: OWNER.uid }).records;
      expect(active).toHaveLength(1);
      expect(active[0]!.id).not.toBe(first.id);
      expect(ctx.responsibilities.get(OWNER.uid, first.id)?.state).toBe("cancelled");
      const incoming = receive(contact, ctx, "human");
      expect(admitContactMessage(contact, incoming.inbox, incoming.message, ctx)).toBe(true);
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
      const forged = receive(contact, ctx, "process", { ...secondMessage.social!.reference, actor: { ...LOCAL, subjectId: "subject:other" } });
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
      const nextGeneration = ctx.federation.activateContact({ ...contact, generation: "generation:next", remoteSubject: contact.remoteSubject, now: Date.now() });
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
  const result = {
    federation: new FederationStore(storage), responsibilities: new ResponsibilityStore(storage),
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*", "r12y.*"] }),
    callerOwnerUid: OWNER.uid, connection: {},
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    procs: { get: (id: string) => ({ ownerUid: OWNER.uid, isPersonalController: id === "proc:ship" }) },
    reconcileResponsibilityWake: vi.fn(async () => {}), broadcastToUserUid: vi.fn(),
  };
  // SAFETY: the handlers use these real stores and the explicit caller, account and scheduling callbacks.
  return result as KernelContext;
}

function activate(ctx: KernelContext): FederationContactRecord {
  return ctx.federation.activateContact({ ownerUid: OWNER.uid, remoteShipId: "ship:remote",
    remoteSubject: { id: "subject:remote", displayName: "Remote" }, remoteOrigin: "https://remote.example",
    remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "secret",
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
    social: { threadId: contact.threadId, reference: { actor: LOCAL, messageId }, provenance: { kind: "human" } } };
}

function receive(contact: FederationContactRecord, ctx: KernelContext, kind: "human" | "process", replyTo?: OriginMessageRef) {
  const messageId = `msg:${crypto.randomUUID()}`;
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const social = { threadId: contact.threadId, reference: { actor: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, messageId },
    provenance: kind === "human" ? { kind: "human" as const } : { kind: "process" as const, processId: "proc:remote" }, ...(replyTo ? { replyTo } : undefined) };
  const inbox = ctx.federation.receive({ contactId: contact.id, contactGeneration: contact.generation, deliveryId,
    wireVersion: 2, payload: { kind: "message", messageId, threadId: contact.threadId, text: "Friday works", social }, payloadHash: messageId }).record;
  const message: ConversationMessage = { id: messageId, sequence: 1, conversationId: contact.conversationId, text: "Friday works", social,
    author: { kind: "contact", contactId: contact.id, shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id, displayName: "Remote" },
    origin: { kind: "federation", contactId: contact.id, deliveryId }, createdAt: Date.now() };
  return { inbox, message };
}
