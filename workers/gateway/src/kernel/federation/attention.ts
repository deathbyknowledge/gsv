import type { ConversationMessage, JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord, FederationInboxRecord, FederationOutboxLocalMessage } from "../federation-store";
import type { ShipEvent } from "../ship-event-store";
import { handleResponsibilityGet } from "../responsibilities";
import { requireContactCaller } from "./authority";

const actor = { kind: "system", component: "contact-conversation" } as const;
const handoffPrefix = (contact: FederationContactRecord) => `contact.handoff:${contact.id}:${contact.generation}:`;
const terminal = (work: ResponsibilityRecord) => work.state === "resolved" || work.state === "cancelled";

export function bindContactReply(contact: FederationContactRecord, message: FederationOutboxLocalMessage, responsibilityId: string, ctx: KernelContext): void {
  requireContactCaller(ctx, true);
  const work = handleResponsibilityGet({ id: responsibilityId }, ctx).responsibility;
  if (work.assignee.kind !== "ship" || terminal(work)) throw new Error("Replies must continue an open Ship responsibility");
  ctx.federation.bindReplyWait(contact, message.messageId, work.id);
}

/**
 * Ending standing handling withdraws its undelivered messages, including those whose
 * handling Ship had already resolved, and cancels its open responsibility. Messages
 * bound to a specific task stay with that task.
 */
export function cancelContactHandling(contact: FederationContactRecord, ctx: KernelContext): void {
  for (const queued of ctx.shipEvents.queuedForContact(contact.ownerUid, contact.id)) {
    const work = ctx.responsibilities.get(contact.ownerUid, queued.responsibilityId);
    if (work?.dedupeKey?.startsWith(handoffPrefix(contact))) ctx.shipEvents.delivered(queued.eventId);
  }
  const existing = standingHandling(contact, ctx);
  if (!existing) return;
  ctx.responsibilities.update({ ownerUid: contact.ownerUid, id: existing.id,
    patch: { state: "cancelled", blocker: null, resolution: { reason: "Person is handling new messages" } },
    actor, observedByShip: false, now: Date.now() });
}

/**
 * Queue a handled contact message for Ship. Each message becomes its own Ship event;
 * the responsibility only records that this contact is owed attention, so a message
 * reuses one that is still open instead of rewriting it.
 */
export function admitContactMessage(contact: FederationContactRecord, inbox: FederationInboxRecord, message: ConversationMessage, ctx: KernelContext): boolean {
  return ctx.federation.transaction(() => {
    const current = ctx.federation.get(contact.id);
    if (!current || current.generation !== inbox.contactGeneration || current.state !== "active" || current.blocked) return false;
    if (!ctx.federation.claimMessageAttention(inbox)) return false;
    // Work waits on this Ship's own messages, so a reply quoting the contact's waits on none.
    const replyTo = message.social?.replyTo;
    const reply = replyTo && replyTo.did !== ctx.shipIdentity.current() ? [] : ctx.federation.replyResponsibilities(current, replyTo);
    // A message without an explicit reply is unambiguous only while one task is awaiting this contact.
    const task = reply.length === 1 ? ctx.responsibilities.get(current.ownerUid, reply[0]) : null;
    let work: ResponsibilityRecord | null = null;
    if (task && task.assignee.kind === "ship" && !terminal(task)) work = attend(task, ctx);
    else if (current.preferences.shipHandlesMessages) work = pendingMessages(current, ctx);
    if (!work) return false;
    const event: ShipEvent = {
      type: "contact.message",
      contactId: current.id,
      contactGeneration: current.generation,
      conversationId: message.conversationId,
      messageId: message.id,
      from: contactDisplayName(current),
      text: message.text,
      responsibilityId: work.id,
      ledgerRevision: ctx.responsibilities.revision(current.ownerUid),
    };
    const media = (message.media ?? []).filter((item) => item.type === "resource");
    if (media.length > 0) event.media = media;
    ctx.shipEvents.enqueue(current.ownerUid, `contact.message:${message.id}`, event, Date.now());
    return true;
  });
}

/**
 * Rebind or revoke a queued contact message before delivery. It is fenced to the
 * contact generation that queued it and stays with open work. If Ship resolved that
 * work while the message waited, the message joins standing handling as a newly
 * arriving one would; cancelled work withdraws it. Returns the event to deliver.
 */
export function admitQueuedContactEvent(ownerUid: number, eventId: string, event: ShipEvent, ctx: KernelContext): ShipEvent | null {
  return ctx.federation.transaction(() => {
    const contact = ctx.federation.get(event.contactId);
    if (!contact || contact.ownerUid !== ownerUid || contact.generation !== event.contactGeneration ||
        contact.state !== "active" || contact.blocked) return null;
    const work = ctx.responsibilities.get(ownerUid, event.responsibilityId);
    if (work && !terminal(work)) return event;
    if (work?.state !== "resolved" || !contact.preferences.shipHandlesMessages) return null;
    const rebound = { ...event, responsibilityId: pendingMessages(contact, ctx).id, ledgerRevision: ctx.responsibilities.revision(ownerUid) };
    ctx.shipEvents.rebind(eventId, rebound);
    return rebound;
  });
}

export function endContactHandling(contact: FederationContactRecord, ctx: KernelContext): boolean {
  const tasks = ctx.federation.replyResponsibilities(contact);
  ctx.federation.clearReplyWaits(contact);
  const handling = standingHandling(contact, ctx);
  if (handling) cancelContactHandling(contact, ctx);
  for (const id of tasks) {
    const work = ctx.responsibilities.get(contact.ownerUid, id);
    if (work && !terminal(work)) reopen(work, { contactDisconnected: { contactId: contact.id, conversationId: contact.conversationId } }, ctx);
  }
  return tasks.length > 0 || !!handling;
}

function standingHandling(contact: FederationContactRecord, ctx: KernelContext): ResponsibilityRecord | undefined {
  return ctx.responsibilities.listActiveByDedupeKeyPrefix(contact.ownerUid, handoffPrefix(contact))[0];
}

function pendingMessages(contact: FederationContactRecord, ctx: KernelContext): ResponsibilityRecord {
  const existing = standingHandling(contact, ctx);
  if (existing) return attend(existing, ctx);
  return ctx.responsibilities.create({
    ownerUid: contact.ownerUid, title: `Pending messages from ${contactDisplayName(contact)}`,
    details: { contactId: contact.id, conversationId: contact.conversationId, contactGeneration: contact.generation },
    source: actor, audience: { conversationIds: [contact.conversationId] }, assignee: { kind: "ship" },
    state: "open", priority: "normal", dedupeKey: `${handoffPrefix(contact)}${crypto.randomUUID()}`,
    actor, observedByShip: false, announced: true, now: Date.now(),
  }).record;
}

/** Return work to Ship's attention; an open Ship record is left untouched. */
function attend(work: ResponsibilityRecord, ctx: KernelContext): ResponsibilityRecord {
  if (work.state === "open" && work.assignee.kind === "ship") return work;
  return ctx.responsibilities.update({ ownerUid: work.ownerUid, id: work.id,
    patch: { state: "open", assignee: { kind: "ship" }, blocker: null, nextCheckAtMs: null, leaseExpiresAtMs: null, resolution: null },
    actor, observedByShip: false, announced: true, now: Date.now() }).record;
}

function reopen(work: ResponsibilityRecord, details: JsonObject, ctx: KernelContext): void {
  ctx.responsibilities.update({ ownerUid: work.ownerUid, id: work.id,
    patch: { state: "open", assignee: { kind: "ship" }, blocker: null, nextCheckAtMs: null, leaseExpiresAtMs: null,
      resolution: null, details: { ...work.details, ...details } },
    actor, observedByShip: false, now: Date.now() });
}
