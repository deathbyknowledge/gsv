import type {
  ApproachContent, ApproachCreateArgs, ApproachDecideArgs, ApproachEnvelope, ApproachGetArgs,
  ApproachListArgs, ApproachListResult, ApproachReceipt, ApproachResult, ApproachRetryArgs, PublicProfile,
} from "@humansandmachines/gsv/protocol";
import { actorRefSchema, approachContentSchema, jsonValueSchema, publicProfileSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import type { KernelContext } from "../context";
import { APPROACH_LIFETIME_MS } from "../approach-store";
import { requireContactHuman } from "../federation/authority";
import { handleProfileResolve, profileOwnerActive } from "../profiles";
import { canonicalJson, randomBase64Url, sha256Base64Url } from "../federation-crypto";
import { localShipDocumentV2 } from "../federation/protocol";
import { consumeLocalRateLimits, consumePublicRateLimits } from "../federation/limits";
import { MAX_PUBLIC_JSON_BYTES } from "../federation/http";
import { PublicFederationError } from "../federation/errors";
import { getConversationById } from "../../shared/utils";
import { stableOpaqueId } from "../../shared/stable-id";
import { approachFingerprint, approachLock, authenticateApproachPeer, sameActor, signApproachValue } from "./shared";

const idSchema = z.string().check(z.minLength(1), z.maxLength(128));
const revisionSchema = z.int().check(z.positive());
const createSchema = z.strictObject({
  profileUrl: z.string().check(z.maxLength(2048)), recipient: actorRefSchema, profileRevision: revisionSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  text: z.string().check(z.minLength(1), z.maxLength(32_768)), idempotencyKey: idSchema,
});

export function handleApproachGet(args: ApproachGetArgs, ctx: KernelContext): ApproachResult {
  return { approach: ctx.approaches.owned(idSchema.parse(args.approachId), requireContactHuman(ctx)).summary };
}

export function handleApproachList(args: ApproachListArgs, ctx: KernelContext): ApproachListResult {
  const ownerUid = requireContactHuman(ctx);
  const direction = z.enum(["incoming", "outgoing"]).parse(args.direction);
  const status = z.optional(z.enum(["active", "history"])).parse(args.status);
  const limit = args.limit ?? 30;
  const before = args.before ? z.strictObject({ createdAtMs: z.int().check(z.positive()), id: idSchema }).parse(args.before) : undefined;
  const approaches = ctx.approaches.list(ownerUid, { direction, status, limit, before });
  const last = approaches.at(-1);
  return { approaches, ...(last && approaches.length === limit ? { next: { createdAtMs: last.createdAtMs, id: last.id } } : undefined) };
}

export async function handleApproachCreate(input: ApproachCreateArgs, ctx: KernelContext): Promise<ApproachResult> {
  const ownerUid = requireContactHuman(ctx);
  const args = createSchema.parse(input);
  return await ctx.coordinateFederationContact(`approach-send:${ownerUid}:${args.idempotencyKey}`, () => createApproach(args, ownerUid, ctx));
}

async function createApproach(args: ApproachCreateArgs, ownerUid: number, ctx: KernelContext): Promise<ApproachResult> {
  if (!args.displayName.trim() || !args.text.trim()) throw new Error("Enter your display name and a message");
  const previous = ctx.approaches.byIdempotencyKey(ownerUid, args.idempotencyKey);
  if (previous) {
    const content = { ...previous.metadata, recipient: args.recipient, profileRevision: args.profileRevision, displayName: args.displayName, text: args.text };
    if (previous.fingerprint !== await approachFingerprint(content, previous.setupTokenHash)
      || new URL(args.profileUrl).origin !== previous.remoteOrigin) throw new Error("This send already has different content");
    return { approach: previous.summary };
  }
  const { profile } = await handleProfileResolve({ url: args.profileUrl }, ctx);
  if (!sameActor(profile.actor, args.recipient) || profile.revision !== args.profileRevision) throw new Error("This profile changed; review it again before sending");
  if (profile.contactPolicy !== "requests") throw new Error("This person is not receiving new message requests");
  const document = await localShipDocumentV2(ctx);
  if (document.shipId === profile.actor.shipId) throw new Error("Choose a person on another GSV");
  const subject = ctx.federation.ensureSubject(ownerUid, args.displayName);
  const existing = ctx.federation.getByRemote(ownerUid, profile.actor.shipId, profile.actor.subjectId);
  if (existing?.state === "active") throw new Error("You already have a conversation with this person");
  const now = Date.now();
  const token = randomBase64Url(32);
  const tokenHash = await sha256Base64Url(token);
  const content: ApproachContent = approachContentSchema.parse({
    reference: { actor: { shipId: document.shipId, subjectId: subject.id }, approachId: `approach:${crypto.randomUUID()}` },
    recipient: profile.actor, profileRevision: profile.revision, displayName: args.displayName,
    messageId: `msg:${crypto.randomUUID()}`, text: args.text, createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
  });
  const fingerprint = await approachFingerprint(content, tokenHash);
  const threadId = `thread:${await sha256Base64Url(`federation-thread\n${token}`)}`;
  // Account for JSON escaping before committing a send that the peer cannot parse.
  if (new TextEncoder().encode(JSON.stringify({ document, content, setup: { token } })).length + 1024 > MAX_PUBLIC_JSON_BYTES) {
    throw new Error("This message exceeds the encoded request limit");
  }
  requireContactHuman(ctx);
  const prepared = ctx.federation.transaction(() => {
    const peerContact = ctx.federation.getByRemote(ownerUid, profile.actor.shipId, profile.actor.subjectId);
    if (peerContact?.state === "active") throw new Error("You already have a conversation with this person");
    const record = ctx.approaches.prepare({
      ownerUid, direction: "outgoing", peer: profile.actor, remoteOrigin: profile.origin, remotePublicKey: profile.publicKey,
      remoteDisplayName: profile.displayName, localDisplayName: args.displayName,
      conversationId: peerContact?.conversationId ?? `conv:${crypto.randomUUID()}`, contactId: peerContact?.id ?? `contact:${crypto.randomUUID()}`,
      threadId, content, fingerprint, idempotencyKey: args.idempotencyKey, setupToken: token, setupTokenHash: tokenHash,
    }, () => consumeLocalRateLimits(ctx, [
      { scope: `owner:${ownerUid}`, operation: "approach.outgoing.day", maximum: 10, windowMs: 86_400_000 },
    ], now, "Daily message request limit reached"));
    if (!record.setupInviteId) {
      const invitation = ctx.federation.createInvite({ ownerUid, tokenHash, issuingShipId: document.shipId, issuingOrigin: document.origin, expiresAtMs: content.expiresAtMs, purpose: "approach", now });
      ctx.approaches.bindInvitation(record.summary.id, invitation.inviteId);
    }
    return ctx.approaches.get(record.summary.id)!;
  });
  await ctx.scheduleApproachMaintenance();
  ctx.broadcastToUserUid(ownerUid, "approach.changed");
  // The durable reservation is the acknowledgement. Conversation append and delivery recover independently.
  return { approach: prepared.summary };
}

export async function handleApproachDecide(args: ApproachDecideArgs, ctx: KernelContext): Promise<ApproachResult> {
  const ownerUid = requireContactHuman(ctx);
  const id = idSchema.parse(args.approachId);
  const revision = revisionSchema.parse(args.expectedRevision);
  const decision = z.enum(["accept", "decline", "withdraw"]).parse(args.decision);
  const existing = ctx.approaches.owned(id, ownerUid);
  const record = await ctx.coordinateFederationContact(approachLock(existing), () => ctx.federation.transaction(() => {
    requireContactHuman(ctx);
    if (decision === "accept") return ctx.approaches.beginAcceptance(id, ownerUid, revision, `attempt:${crypto.randomUUID()}`);
    const changed = ctx.approaches.decide(id, ownerUid, revision, decision === "decline" ? "declined" : "withdrawn");
    if (changed.setupInviteId && ctx.federation.invite(changed.setupInviteId)?.state === "issued") {
      ctx.federation.cancelInvite(changed.setupInviteId, ownerUid);
    }
    return changed;
  }));
  await ctx.scheduleApproachMaintenance();
  ctx.broadcastToUserUid(ownerUid, "approach.changed");
  return { approach: record.summary };
}

export async function handleApproachRetry(args: ApproachRetryArgs, ctx: KernelContext): Promise<ApproachResult> {
  const ownerUid = requireContactHuman(ctx);
  const record = ctx.approaches.retry(idSchema.parse(args.approachId), ownerUid, revisionSchema.parse(args.expectedRevision));
  await ctx.scheduleApproachMaintenance();
  ctx.broadcastToUserUid(ownerUid, "approach.changed");
  return { approach: record.summary };
}

export async function receiveApproach(envelope: ApproachEnvelope, ctx: KernelContext): Promise<ApproachReceipt> {
  const { content, document } = envelope;
  const local = await localShipDocumentV2(ctx);
  if (content.recipient.shipId !== local.shipId || document.shipId === local.shipId) throw new PublicFederationError(404, "Message requests are unavailable");
  const ownerUid = ctx.federation.subjectOwner(content.recipient.subjectId);
  if (ownerUid === null || !profileOwnerActive(ownerUid, ctx)) throw new PublicFederationError(404, "Message requests are unavailable");
  const prior = ctx.approaches.byReference(ownerUid, content.reference);
  await authenticateApproachPeer(envelope, content.reference.actor, ctx, prior ?? undefined);
  const tokenHash = await sha256Base64Url(envelope.setup.token);
  const fingerprint = await approachFingerprint(content, tokenHash);
  let profile: PublicProfile | null = null;
  if (!prior) {
    const projection = ctx.profiles.published({ subjectId: content.recipient.subjectId });
    if (!projection) throw new PublicFederationError(404, "Message requests are unavailable");
    const object = await ctx.env.STORAGE.get(projection.key);
    if (!object || object.size > 16_384) {
      await object?.body.cancel();
      throw new PublicFederationError(404, "Message requests are unavailable");
    }
    profile = publicProfileSchema.parse(await object.json());
  }
  const peer = content.reference.actor;
  const threadId = `thread:${await sha256Base64Url(`federation-thread\n${envelope.setup.token}`)}`;
  const existing = ctx.federation.getByRemote(ownerUid, peer.shipId, peer.subjectId);
  const received = ctx.federation.transaction(() => ctx.approaches.prepare({
    ownerUid, direction: "incoming", peer, remoteOrigin: document.origin, remotePublicKey: document.publicKey,
    remoteDisplayName: content.displayName, localDisplayName: profile?.displayName ?? prior!.localDisplayName,
    conversationId: prior?.summary.conversationId ?? existing?.conversationId ?? `conv:${crypto.randomUUID()}`,
    contactId: prior?.contactId ?? existing?.id ?? `contact:${crypto.randomUUID()}`, threadId, content, fingerprint,
    setupToken: envelope.setup.token, setupTokenHash: tokenHash,
  }, () => {
    const projection = ctx.profiles.published({ subjectId: content.recipient.subjectId });
    if (!profile || !projection || !profileOwnerActive(ownerUid, ctx) || projection.revision !== profile.revision
      || profile.contactPolicy !== "requests" || profile.revision !== content.profileRevision
      || !sameActor(profile.actor, content.recipient) || existing?.state === "active") throw new PublicFederationError(404, "Message requests are unavailable");
    if (existing && (existing.remoteOrigin !== document.origin
      || canonicalJson(jsonValueSchema.parse(existing.remotePublicKey)) !== canonicalJson(jsonValueSchema.parse(document.publicKey)))) throw new PublicFederationError(403, "Message request authentication failed");
    consumePublicRateLimits(ctx, [
      { scope: `owner:${ownerUid}`, operation: "approach.incoming.hour", maximum: 60, windowMs: 3_600_000 },
      { scope: `owner:${ownerUid}`, operation: "approach.incoming.day", maximum: 100, windowMs: 86_400_000 },
      { scope: "installation", operation: "approach.incoming.day", maximum: 500, windowMs: 86_400_000 },
      { scope: `approach:${ownerUid}:${peer.shipId}:${peer.subjectId}`, operation: "approach.pair.day", maximum: 5, windowMs: 86_400_000 },
    ], Date.now(), "Message request limit reached");
  }));
  await ctx.scheduleApproachMaintenance();
  await ctx.coordinateFederationContact(approachLock(received), () => appendApproachMessage(received.summary.id, ctx));
  return await signApproachValue({ version: 2, domain: "gsv-federation/2/approach-receipt", reference: content.reference, recipient: content.recipient, fingerprint } satisfies Omit<ApproachReceipt, "signature">, ctx);
}

export async function appendApproachMessage(id: string, ctx: KernelContext): Promise<void> {
  const record = ctx.approaches.get(id);
  if (!record || record.messageSequence !== null || record.summary.state !== "preparing") return;
  if (!record.pendingText) throw new Error("Message request append payload is unavailable");
  const { summary, metadata } = record;
  const conversation = ctx.conversations.ensureContact(record.ownerUid, summary.displayName, summary.conversationId);
  const established = ctx.federation.get(record.contactId);
  const stub = getConversationById(ctx.installationId, conversation.id);
  await stub.initialize({ ownerUid: record.ownerUid, kind: "contact", ...(established ? undefined : { intakeId: id }) });
  const message = await stub.append({
    messageId: await stableOpaqueId("msg", [metadata.reference.actor.shipId, metadata.reference.actor.subjectId, metadata.messageId]),
    idempotencyKey: `approach:${id}`, text: record.pendingText,
    author: summary.direction === "incoming" ? { kind: "contact", contactId: record.contactId, shipId: summary.peer.shipId, subjectId: summary.peer.subjectId, displayName: summary.displayName } : { kind: "user", uid: record.ownerUid },
    social: { reference: { actor: metadata.reference.actor, messageId: metadata.messageId }, threadId: record.threadId, provenance: { kind: "human" } },
    origin: summary.direction === "incoming" ? { kind: "federation", contactId: record.contactId, deliveryId: metadata.reference.approachId } : { kind: "client" },
    createdAt: metadata.createdAtMs,
  });
  ctx.approaches.messageCommitted(id, message.message.sequence);
  ctx.conversations.recordSequence(conversation.id, message.message.sequence);
  if (message.created) {
    ctx.broadcastToUserUid(record.ownerUid, "message.committed", { message: message.message, directed: false });
    ctx.broadcastToUserUid(record.ownerUid, "conversation.changed", { conversationId: conversation.id, latestSequence: message.message.sequence });
  }
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
}
