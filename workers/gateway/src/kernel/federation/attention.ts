import type { ConversationMessage, JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord, FederationInboxRecord, FederationOutboxLocalMessage } from "../federation-store";
import { handleResponsibilityGet } from "../responsibilities";
import { requireContactCaller } from "./authority";

const actor = { kind: "system", component: "contact-conversation" } as const;
const handoffPrefix = (contact: FederationContactRecord) => `contact.handoff:${contact.id}:${contact.generation}:`;
const terminal = (work: ResponsibilityRecord) => work.state === "resolved" || work.state === "cancelled";

export function bindContactReply(contact: FederationContactRecord, message: FederationOutboxLocalMessage, responsibilityId: string, ctx: KernelContext): void {
  requireContactCaller(ctx, true);
  const work = handleResponsibilityGet({ id: responsibilityId }, ctx).responsibility;
  if (work.assignee.kind !== "ship" || terminal(work)) throw new Error("Replies must continue an open Ship responsibility");
  ctx.federation.bindReplyWait(contact, message.messageId, message.social?.reference.actor, work.id);
}

export function changeContactHandling(contact: FederationContactRecord, ctx: KernelContext, messageDetails: JsonObject = {}): void {
  const existing = ctx.responsibilities.listActiveByDedupeKeyPrefix(contact.ownerUid, handoffPrefix(contact))[0];
  if (contact.preferences.shipHandlesMessages) {
    if (contact.state !== "active" || contact.blocked) throw new Error("Only an active contact can be handed to Ship");
    const details = { contactId: contact.id, conversationId: contact.conversationId, contactGeneration: contact.generation, ...messageDetails };
    if (existing) reopen(existing, details, ctx);
    else ctx.responsibilities.create({
      ownerUid: contact.ownerUid, title: "Handle this contact conversation", details, source: actor,
      audience: { conversationIds: [contact.conversationId] }, assignee: { kind: "ship" },
      state: "open", priority: "normal", dedupeKey: `${handoffPrefix(contact)}${crypto.randomUUID()}`, actor, observedByShip: false, now: Date.now(),
    });
  } else if (existing) {
    ctx.responsibilities.update({ ownerUid: contact.ownerUid, id: existing.id,
      patch: { state: "cancelled", blocker: null, resolution: { reason: "Person is handling new messages" } },
      actor, observedByShip: false, now: Date.now() });
  }
}

export function admitContactMessage(contact: FederationContactRecord, inbox: FederationInboxRecord, message: ConversationMessage, ctx: KernelContext): boolean {
  return ctx.federation.transaction(() => {
    const current = ctx.federation.get(contact.id);
    if (!current || current.generation !== inbox.contactGeneration || current.state !== "active" || current.blocked) return false;
    if (!ctx.federation.claimMessageAttention(inbox)) return false;
    const reply = ctx.federation.replyResponsibilities(current, message.social?.replyTo);
    // A message without an explicit reply is unambiguous only while one task is awaiting this contact.
    const task = reply.length === 1 ? ctx.responsibilities.get(current.ownerUid, reply[0]) : null;
    const details: JsonObject = {
      contactReply: { contactId: current.id, contactGeneration: current.generation,
        conversationId: message.conversationId, messageId: message.id, sequence: message.sequence,
        provenance: message.social?.provenance.kind ?? "unknown", contentTrust: "untrusted" },
    };
    if (task && task.assignee.kind === "ship" && !terminal(task)) {
      reopen(task, details, ctx);
      return true;
    }
    if (!current.preferences.shipHandlesMessages) return false;
    changeContactHandling(current, ctx, details);
    return true;
  });
}

export function endContactHandling(contact: FederationContactRecord, ctx: KernelContext): boolean {
  const tasks = ctx.federation.replyResponsibilities(contact);
  ctx.federation.clearReplyWaits(contact);
  const handling = ctx.responsibilities.listActiveByDedupeKeyPrefix(contact.ownerUid, handoffPrefix(contact))[0];
  if (handling) changeContactHandling({ ...contact, preferences: { ...contact.preferences, shipHandlesMessages: false } }, ctx);
  for (const id of tasks) {
    const work = ctx.responsibilities.get(contact.ownerUid, id);
    if (work && !terminal(work)) reopen(work, { contactDisconnected: { contactId: contact.id, conversationId: contact.conversationId } }, ctx);
  }
  return tasks.length > 0 || !!handling;
}

function reopen(work: ResponsibilityRecord, details: JsonObject, ctx: KernelContext): void {
  ctx.responsibilities.update({ ownerUid: work.ownerUid, id: work.id,
    patch: { state: "open", assignee: { kind: "ship" }, blocker: null, nextCheckAtMs: null, leaseExpiresAtMs: null,
      resolution: null, details: { ...work.details, ...details } },
    actor, observedByShip: false, now: Date.now() });
}
