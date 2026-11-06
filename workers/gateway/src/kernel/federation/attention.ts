import type { ConversationMessage, JsonObject, ResourceBlock, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { contactDisplayName, resourceBlockSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { getConversationById } from "../../shared/utils";
import type { KernelContext } from "../context";
import { shipConsumer } from "../events/consumers";
import type { EventDefinition, Withdrawn } from "../events/registry";
import type { LoggedEvent } from "../events/store";
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
  ctx.federation.bindReplyWait(contact, message.messageId, work.id);
}

/**
 * Ending standing handling withdraws its undelivered messages, including those whose
 * handling Ship had already resolved, and cancels its open responsibility. Messages
 * bound to a specific task stay with that task.
 */
export function cancelContactHandling(contact: FederationContactRecord, ctx: KernelContext): void {
  for (const queued of ctx.events.pending("contact.message", contact.id)) {
    const work = ctx.responsibilities.get(contact.ownerUid, contactMessageBody(queued.event).responsibilityId);
    if (work?.dedupeKey?.startsWith(handoffPrefix(contact))) ctx.events.withdraw(queued, "the person took over its contact");
  }
  const existing = standingHandling(contact, ctx);
  if (!existing) return;
  ctx.responsibilities.update({ ownerUid: contact.ownerUid, id: existing.id,
    patch: { state: "cancelled", blocker: null, resolution: { reason: "Person is handling new messages" } },
    actor, observedByShip: false, now: Date.now() });
}

/**
 * Append a handled contact message for Ship. Each message becomes its own event, naming
 * its Conversation message; the responsibility only records that this contact is owed
 * attention, so a message reuses one that is still open instead of rewriting it. A
 * message Ship doesn't handle becomes a notice for the person instead.
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
    if (!work) {
      // The person handles this message, so their messenger hears of it.
      if (!current.preferences.muted) {
        ctx.ownerNotices.noteContactMessage(current.ownerUid, {
          contactId: current.id,
          contactGeneration: current.generation,
          conversationId: message.conversationId,
          from: contactDisplayName(current),
          preview: message.text,
        }, message.sequence, Date.now());
      }
      return false;
    }
    // The message is new input for its work, so recovery after it starts over.
    ctx.responsibilities.restartRecovery(current.ownerUid, work.id);
    ctx.events.append({
      type: "contact.message",
      ownerUid: current.ownerUid,
      subject: current.id,
      actor: { kind: "contact", contactId: current.id },
      key: message.id,
      body: {
        contactId: current.id,
        contactGeneration: current.generation,
        conversationId: message.conversationId,
        sequence: message.sequence,
        messageId: message.id,
        responsibilityId: work.id,
        ledgerRevision: ctx.responsibilities.revision(current.ownerUid),
      },
    });
    return true;
  });
}

const contactMessageBodySchema = z.object({
  contactId: z.string(),
  contactGeneration: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  responsibilityId: z.string(),
  ledgerRevision: z.number().int().nonnegative(),
}).and(z.union([
  z.object({ sequence: z.number().int().nonnegative() }),
  // Queued for Ship before v092 moved its events into the log: these carry their words.
  // TODO(event-log): remove with the branch in prepare the release after the cutover ships,
  // withdrawing any moved message still pending in the same change.
  z.object({ text: z.string(), media: z.array(z.custom<ResourceBlock>((value) => resourceBlockSchema.safeParse(value).success)).optional() }),
]));

type ContactMessageBody = z.infer<typeof contactMessageBodySchema>;

/** What a contact message reads in its Conversation when it goes to Ship. */
export type ContactMessageContent = { text: string; attachments: ResourceBlock[] };

function contactMessageBody(event: LoggedEvent): ContactMessageBody {
  return contactMessageBodySchema.parse(event.body);
}

/**
 * A contact message for the owner's Ship, read from its Conversation when it goes. It is
 * fenced to the contact generation that admitted it and stays with open work. If Ship
 * resolved that work while the message waited, the message joins standing handling as a
 * newly arriving one would; cancelled work, a block or a changed relationship withdraws it.
 */
export const contactMessageEvent: EventDefinition<ContactMessageContent> = {
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
  withdrawal(event, ctx) {
    const target = contactMessageTarget(event.ownerUid, contactMessageBody(event), ctx);
    return "withdrawn" in target ? target.withdrawn : null;
  },
  async prepare(event, ctx) {
    const body = contactMessageBody(event);
    if (!("sequence" in body)) return { text: body.text, attachments: body.media ?? [] };
    const message = await getConversationById(ctx.installationId, body.conversationId)
      .readMessage({ sequence: body.sequence, messageId: body.messageId });
    if (!message) return { withdrawn: "the message is no longer in its conversation" };
    return { text: message.text, attachments: (message.media ?? []).filter((item) => item.type === "resource") };
  },
  admit(event, content, ctx) {
    return ctx.federation.transaction(() => {
      const body = contactMessageBody(event);
      const target = contactMessageTarget(event.ownerUid, body, ctx);
      if ("withdrawn" in target) return target;
      const work = target.work ?? pendingMessages(target.contact, ctx);
      if (!target.work) ctx.responsibilities.restartRecovery(event.ownerUid, work.id);
      return {
        event: {
          kind: "contact.message", severity: "info", audience: "model",
          payload: {
            contactId: target.contact.id, conversationId: body.conversationId, messageId: body.messageId,
            from: contactDisplayName(target.contact), text: content.text, responsibilityId: work.id,
          },
        },
        admission: { idle: "start", busy: "join" },
        responsibilities: { ledgerRevision: target.work ? body.ledgerRevision : ctx.responsibilities.revision(event.ownerUid), ids: [work.id] },
        ...(content.attachments.length > 0 ? { attachments: content.attachments } : undefined),
      };
    });
  },
  // A delivered message armed its work's recovery wake.
  settled: (event, ctx) => ctx.reconcileResponsibilityWake(event.ownerUid),
};

/** The contact a queued message goes to and its open work, null when standing handling takes it; or why it should not go. */
function contactMessageTarget(
  ownerUid: number, body: ContactMessageBody, ctx: KernelContext,
): { contact: FederationContactRecord; work: ResponsibilityRecord | null } | Withdrawn {
  const contact = ctx.federation.get(body.contactId);
  if (!contact || contact.ownerUid !== ownerUid || contact.generation !== body.contactGeneration || contact.state !== "active") {
    return { withdrawn: "the contact relationship changed" };
  }
  if (contact.blocked) return { withdrawn: "the contact is blocked" };
  const work = ctx.responsibilities.get(ownerUid, body.responsibilityId);
  if (work && !terminal(work)) return { contact, work };
  if (work?.state === "resolved" && contact.preferences.shipHandlesMessages) return { contact, work: null };
  return { withdrawn: "Ship no longer handles the message" };
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
    details: { contactId: contact.id, conversationId: contact.conversationId, contactGeneration: contact.generation, contentTrust: "untrusted" },
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
