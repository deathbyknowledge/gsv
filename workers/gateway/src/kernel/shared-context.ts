import { z } from "zod/mini";
import {
  actorRefSchema, jsonValueSchema, sharedContextAssertionSchema, sharedContextKindSchema, sharedContextKindsSchema,
  sharedContextRecordSchema, socialIdSchema,
  type ContactContextListArgs, type ContactContextListResult, type ContactContextSourcesResult,
  type ContactContextSubscribeArgs, type ContactContextSubscribeResult, type ContactContextSyncArgs, type ContactContextSyncResult,
  type ContactContextPublicationsArgs, type ContactContextPublicationsResult, type ContactContextPublishArgs, type ContactContextPublishResult,
  type ContactContextWithdrawArgs, type ContactContextWithdrawResult, type ContactContextConsentArgs, type ContactContextConsentResult,
  type FederationContextDelivery, type SharedContextConsent, type SharedContextQuote,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { FederationContactRecord, FederationReadyOutboxRecord } from "./federation-store";
import { requireContactCaller, requireContactHuman, requireOwnedActiveContact, requireOwnedActiveContactGeneration } from "./federation/authority";
import { assertOutboundCapacity, consumeOutboundDeliveryRate, consumePublicRateLimits } from "./federation/limits";
import { federationInputFingerprint, rearmPendingDelivery } from "./federation/delivery";
import { FederationHttpError, PublicFederationError } from "./federation/errors";
import { publication } from "./shared-context-publications";
import { assertionHash, CONTEXT_LIFETIME_MS, remoteActor, sameActor, syncContextSource, verifyContextAssertion, verifyContextConsent } from "./shared-context-wire";
import { getConversationById } from "../shared/utils";
import { negotiateContactProtocol } from "./federation/protocol";

const revision = z.int().check(z.nonnegative());
const listSchema = z.strictObject({ subject: z.optional(actorRefSchema), sourceContactId: z.optional(socialIdSchema),
  cursor: z.optional(z.string().check(z.maxLength(4096))), limit: z.optional(z.int().check(z.minimum(1), z.maximum(100))) }) satisfies z.ZodMiniType<ContactContextListArgs>;
const subscribeSchema = z.strictObject({ contactId: socialIdSchema, expectedGeneration: socialIdSchema, expectedRevision: revision, kinds: sharedContextKindsSchema }) satisfies z.ZodMiniType<ContactContextSubscribeArgs>;
const publishSchema = z.strictObject({
  id: socialIdSchema, expectedRevision: revision, idempotencyKey: socialIdSchema, subject: actorRefSchema, kind: sharedContextKindSchema,
  label: z.string().check(z.minLength(1), z.maxLength(80)), text: z.string().check(z.maxLength(1024)), category: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  expiresAtMs: z.int().check(z.minimum(1)), evidence: z.optional(z.array(z.strictObject({ conversationId: socialIdSchema,
    messageId: socialIdSchema, sequence: z.int().check(z.minimum(1)), text: z.string().check(z.minLength(1), z.maxLength(512)) })).check(z.maxLength(3))),
  retainEvidence: z.optional(z.boolean()),
}) satisfies z.ZodMiniType<ContactContextPublishArgs>;
const consentSchema = z.strictObject({ contactId: socialIdSchema, expectedGeneration: socialIdSchema, assertionId: socialIdSchema,
  assertionRevision: z.int().check(z.minimum(1)), expectedDecisionRevision: z.int().check(z.minimum(0), z.maximum(2)),
  decision: z.enum(["approve", "decline", "withdraw"]) }) satisfies z.ZodMiniType<ContactContextConsentArgs>;

export function handleContactContextList(raw: ContactContextListArgs, ctx: KernelContext): ContactContextListResult {
  const ownerUid = requireContactCaller(ctx, false);
  return ctx.sharedContext.sources.entries(ownerUid, listSchema.parse(raw));
}

export function handleContactContextSources(ctx: KernelContext): ContactContextSourcesResult {
  return { sources: ctx.sharedContext.sources.list(requireContactHuman(ctx)) };
}

export async function handleContactContextSubscribe(raw: ContactContextSubscribeArgs, ctx: KernelContext): Promise<ContactContextSubscribeResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = subscribeSchema.parse(raw);
  const contact = requireOwnedActiveContact(args.contactId, ownerUid, ctx);
  if (contact.generation !== args.expectedGeneration) throw new Error("Contact changed; review this subscription again");
  const source = ctx.sharedContext.sources.subscribe(contact, args.expectedRevision, args.kinds);
  ctx.broadcastToUserUid(ownerUid, "contact.context.changed");
  await ctx.scheduleSharedContext();
  return { source };
}

export async function handleContactContextSync(raw: ContactContextSyncArgs, ctx: KernelContext): Promise<ContactContextSyncResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = z.strictObject({ contactId: socialIdSchema, expectedRevision: revision }).parse(raw);
  requireOwnedActiveContact(args.contactId, ownerUid, ctx);
  ctx.sharedContext.sources.schedule(args.contactId, args.expectedRevision);
  await ctx.scheduleSharedContext();
  return { scheduled: true };
}

export function handleContactContextPublications(raw: ContactContextPublicationsArgs, ctx: KernelContext): ContactContextPublicationsResult {
  const ownerUid = requireContactHuman(ctx);
  const args = z.strictObject({ section: z.enum(["publications", "consents"]), cursor: z.optional(z.string().check(z.maxLength(1024))), limit: z.optional(z.int().check(z.minimum(1), z.maximum(20))) }).parse(raw);
  return ctx.sharedContext.publications.ownedPage(ownerUid, args);
}

export function assertCurrentContextDelivery(record: FederationReadyOutboxRecord, ctx: KernelContext): void {
  const payload = record.payload;
  if (payload.kind === "context.consent.request") {
    const current = ctx.sharedContext.publications.row(record.ownerUid, payload.record.assertion.id);
    if (!current || current.state === "withdrawn" || current.revision !== payload.record.assertion.revision || current.expires_at <= Date.now()) throw new FederationHttpError(409, "Connection proposal was superseded or expired");
  } else if (payload.kind === "context.consent.decision") {
    const current = ctx.sharedContext.publications.consentRequest(record.contactId, payload.consent.assertionId);
    if (!current?.consent || current.generation !== record.contactGeneration || JSON.stringify(current.consent) !== JSON.stringify(payload.consent)) throw new FederationHttpError(409, "Connection consent was superseded");
  }
}

export async function handleContactContextPublish(raw: ContactContextPublishArgs, ctx: KernelContext): Promise<ContactContextPublishResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = publishSchema.parse(raw);
  const store = ctx.sharedContext.publications;
  const fingerprint = await federationInputFingerprint(jsonValueSchema.parse(args));
  const previous = store.row(ownerUid, args.id);
  if (previous?.intent_id === args.idempotencyKey) {
    if (previous.intent_hash !== fingerprint) throw new Error("Publication intent was reused for different content");
    if (previous.delivery_id) {
      const delivery = ctx.federation.outbox(previous.delivery_id);
      if (delivery) await rearmPendingDelivery(delivery, ctx);
    }
    await ctx.scheduleSharedContext();
    return { publication: publication(previous) };
  }
  if ((previous?.revision ?? 0) !== args.expectedRevision) throw new Error("Shared statement changed; review it again");
  const now = Date.now();
  if (args.expiresAtMs <= now || args.expiresAtMs > now + CONTEXT_LIFETIME_MS) throw new Error("Choose an expiry within the next 30 days");
  const identity = await localActor(ownerUid, ctx);
  if (sameActor(identity.actor, args.subject)) throw new Error("Choose another person for this statement");
  let contact: FederationContactRecord | undefined;
  if (args.kind === "connection") {
    const found = ctx.federation.getByRemote(ownerUid, args.subject.shipId, args.subject.subjectId);
    if (!found || found.state !== "active") throw new Error("Connection disclosure requires an active conversation with that person");
    contact = await negotiateContactProtocol(found, ctx);
    if (!contact.protocol?.features.includes("context")) throw new Error("This person's GSV does not support connection consent yet");
  }
  if (args.retainEvidence && (!previous || args.evidence?.length)) throw new Error("Choose either the existing quotes or a new selection");
  const evidence: SharedContextQuote[] = args.retainEvidence && previous
    ? sharedContextRecordSchema.parse(JSON.parse(previous.record_json)).assertion.evidence : [];
  for (const selected of args.evidence ?? []) {
    const conversation = ctx.conversations.get(selected.conversationId);
    if (!conversation || conversation.ownerUid !== ownerUid) throw new Error("Selected evidence is unavailable");
    const history = await getConversationById(ctx.installationId, conversation.id).history({ beforeSequence: selected.sequence + 1, limit: 1 });
    const message = history.messages[0];
    if (!message || message.id !== selected.messageId || message.sequence !== selected.sequence || !message.text.includes(selected.text)) throw new Error("Selected quote no longer matches its committed message");
    evidence.push({ text: selected.text, ...(message.social ? { reference: message.social.reference } : undefined) });
  }
  const assertion = sharedContextAssertionSchema.parse({ domain: "gsv-federation/2/context", id: args.id, issuer: identity.actor,
    subject: args.subject, revision: args.expectedRevision + 1, kind: args.kind, label: args.label.trim(), text: args.text.trim(),
    ...(args.category ? { category: args.category.trim() } : undefined), evidence, audience: "subscribed-direct-contacts", issuedAtMs: now, expiresAtMs: args.expiresAtMs });
  const record = { assertion, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(assertion)) };
  const deliveryId = contact ? `delivery:${crypto.randomUUID()}` : undefined;
  requireContactHuman(ctx);
  const result = ctx.federation.transaction(() => {
    if (contact) requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    for (const selected of args.evidence ?? []) if (ctx.conversations.get(selected.conversationId)?.ownerUid !== ownerUid) throw new Error("Selected evidence is unavailable");
    const raced = store.row(ownerUid, args.id);
    if (raced?.intent_id === args.idempotencyKey) {
      if (raced.intent_hash !== fingerprint) throw new Error("Publication intent was reused for different content");
      return publication(raced);
    }
    const result = store.write({ ownerUid, expectedRevision: args.expectedRevision, expectedSequence: previous?.sequence ?? 0, record, intentId: args.idempotencyKey, intentHash: fingerprint, contact, deliveryId });
    if (contact && deliveryId) {
      store.rememberProposal(contact, store.row(ownerUid, args.id)!);
      enqueueContext(contact, { kind: "context.consent.request", record }, deliveryId, `context-proposal:${args.id}:${assertion.revision}`, ctx);
    }
    return result;
  });
  ctx.broadcastToUserUid(ownerUid, "contact.context.changed");
  if (result.deliveryId) await ctx.scheduleFederationDelivery(result.deliveryId, Date.now(), true);
  await ctx.scheduleSharedContext();
  return { publication: result };
}

export async function handleContactContextWithdraw(raw: ContactContextWithdrawArgs, ctx: KernelContext): Promise<ContactContextWithdrawResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = z.strictObject({ id: socialIdSchema, expectedRevision: z.int().check(z.minimum(1)) }).parse(raw);
  const result = ctx.federation.transaction(() => ctx.sharedContext.publications.withdraw(ownerUid, args.id, args.expectedRevision));
  ctx.broadcastToUserUid(ownerUid, "contact.context.changed");
  await ctx.scheduleSharedContext();
  return { publication: result };
}

export async function handleContactContextConsent(raw: ContactContextConsentArgs, ctx: KernelContext): Promise<ContactContextConsentResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = consentSchema.parse(raw);
  const contact = requireOwnedActiveContact(args.contactId, ownerUid, ctx);
  if (contact.generation !== args.expectedGeneration) throw new Error("Connection changed");
  const current = ctx.sharedContext.publications.consentRequest(contact.id, args.assertionId);
  if (!current || current.generation !== contact.generation || current.record.assertion.revision !== args.assertionRevision) throw new Error("Connection proposal changed");
  if (current.consent?.decisionRevision === args.expectedDecisionRevision + 1 && current.consent.decision === args.decision) {
    if (current.deliveryId) { const delivery = ctx.federation.outbox(current.deliveryId); if (delivery) await rearmPendingDelivery(delivery, ctx); }
    return { consentRequest: current };
  }
  if ((current.consent?.decisionRevision ?? 0) !== args.expectedDecisionRevision || (args.decision === "withdraw" ? current.consent?.decision !== "approve" : !!current.consent)) throw new Error("Connection consent changed; review it again");
  if (args.decision === "approve" && current.record.assertion.expiresAtMs <= Date.now()) throw new Error("This connection proposal expired");
  const identity = await localActor(ownerUid, ctx);
  const unsigned: Omit<SharedContextConsent, "signature"> = {
    domain: "gsv-federation/2/context-consent", actor: identity.actor, assertionId: args.assertionId, assertionRevision: args.assertionRevision,
    assertionHash: await assertionHash(current.record), decision: args.decision, decisionRevision: args.expectedDecisionRevision + 1,
    expiresAtMs: current.record.assertion.expiresAtMs, publicKey: identity.publicKey,
  };
  const consent = { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  requireContactHuman(ctx);
  const result = ctx.federation.transaction(() => {
    requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    const updated = ctx.sharedContext.publications.decide(contact, args.expectedDecisionRevision, consent, deliveryId);
    enqueueContext(contact, { kind: "context.consent.decision", consent }, deliveryId, `context-consent:${args.assertionId}:${args.assertionRevision}:${consent.decisionRevision}`, ctx);
    return updated;
  });
  ctx.broadcastToUserUid(ownerUid, "contact.context.changed");
  await ctx.scheduleFederationDelivery(deliveryId, Date.now(), true);
  return { consentRequest: result };
}

export async function commitInboundContext(payload: FederationContextDelivery, contact: FederationContactRecord, ctx: KernelContext): Promise<void> {
  const store = ctx.sharedContext.publications;
  if (payload.kind === "context.consent.request") {
    try { await verifyContextAssertion(payload.record, contact.remotePublicKey, remoteActor(contact)); }
    catch { throw new PublicFederationError(403, "Invalid connection proposal"); }
    const identity = await localActor(contact.ownerUid, ctx);
    if (payload.record.assertion.kind !== "connection" || !sameActor(payload.record.assertion.subject, identity.actor)) throw new PublicFederationError(403, "Connection proposal does not concern this person");
    ctx.federation.transaction(() => {
      requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx);
      if (!store.consentRequest(contact.id, payload.record.assertion.id)) consumePublicRateLimits(ctx, [
        { scope: `context-consent:${contact.id}`, operation: "context.propose", maximum: 12, windowMs: 24 * 60 * 60_000 },
      ], Date.now(), "Connection proposal limit reached");
      store.receiveConsentRequest(contact, payload.record);
    });
  } else if (payload.kind === "context.consent.decision") {
    const row = store.row(contact.ownerUid, payload.consent.assertionId);
    if (!row || row.revision !== payload.consent.assertionRevision) return;
    if (!sameActor(payload.consent.actor, remoteActor(contact))) throw new PublicFederationError(403, "Consent signer does not match the sender");
    try { await verifyContextConsent(sharedContextRecordSchema.parse(JSON.parse(row.record_json)), payload.consent); }
    catch { throw new PublicFederationError(403, "Invalid connection consent"); }
    ctx.federation.transaction(() => { requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx); store.consent(contact.ownerUid, payload.consent, contact); });
  } else {
    ctx.federation.transaction(() => {
      requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx);
      ctx.sharedContext.sources.receiveWithdrawal(contact, payload.assertionId, payload.throughRevision);
      if (payload.consentProposal) store.cancelConsentRequest(contact, payload.assertionId, payload.throughRevision);
    });
  }
  ctx.broadcastToUserUid(contact.ownerUid, "contact.context.changed");
  await ctx.scheduleSharedContext();
}

export async function processSharedContext(ctx: KernelContext): Promise<void> {
  ctx.federation.transaction(() => ctx.sharedContext.publications.prune());
  for (const receipt of ctx.sharedContext.publications.withdrawals()) {
    const contact = ctx.federation.get(receipt.contact_id);
    if (!contact || contact.generation !== receipt.generation || contact.state !== "active") {
      ctx.sharedContext.publications.sentWithdrawal(receipt); continue;
    }
    const deliveryId = `delivery:${crypto.randomUUID()}`;
    const intent = `context-withdraw:${receipt.assertion_id}:${receipt.withdraw_through}:${contact.id}:${contact.generation}`;
    const existing = ctx.federation.outboxByIdempotency(contact.ownerUid, intent);
    ctx.federation.transaction(() => {
      if (!existing) enqueueContext(contact, { kind: "context.withdraw", assertionId: receipt.assertion_id, throughRevision: receipt.withdraw_through,
        ...(receipt.consent_proposal ? { consentProposal: true } : undefined) }, deliveryId, intent, ctx);
      ctx.sharedContext.publications.sentWithdrawal(receipt);
    });
    if (existing) await rearmPendingDelivery(existing, ctx);
    else await ctx.scheduleFederationDelivery(deliveryId, Date.now(), true);
  }
  await syncContextSource(ctx);
}

function enqueueContext(contact: FederationContactRecord, payload: FederationContextDelivery, deliveryId: string, idempotencyKey: string, ctx: KernelContext): void {
  const now = Date.now();
  assertOutboundCapacity(contact.ownerUid, contact.id, ctx, now);
  consumeOutboundDeliveryRate(contact.ownerUid, contact.id, ctx, now);
  ctx.federation.enqueue({ deliveryId, ownerUid: contact.ownerUid, contactId: contact.id, contactGeneration: contact.generation,
    idempotencyKey, fingerprint: JSON.stringify(payload), wireVersion: 2, payload, now });
}

async function localActor(ownerUid: number, ctx: KernelContext) {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  const account = ctx.auth.getPasswdByUid(ownerUid);
  if (!origin || !account) throw new Error("Local shared context identity is unavailable");
  const identity = await ctx.federationIdentity.ensure(origin);
  const subject = ctx.federation.ensureSubject(ownerUid, account.gecos || account.username);
  return { actor: { shipId: identity.shipId, subjectId: subject.id }, publicKey: identity.publicKey };
}
