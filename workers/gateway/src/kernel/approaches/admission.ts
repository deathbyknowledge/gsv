import type {
  ApproachCreateArgs, ApproachDecideArgs, ApproachGetArgs, ApproachListArgs, ApproachListResult,
  ApproachResult, ApproachRetryArgs, JsonValue, MessageRequestOutput, PublicProfile, SendMessageRequestInput,
} from "@humansandmachines/gsv/protocol";
import { didSchema, jsonObjectSchema, profileContactPolicy, sendMessageRequestInputSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import { ensureShipAccount } from "../atproto";
import type { KernelContext } from "../context";
import { APPROACH_LIFETIME_MS } from "../approach-store";
import { contactHandlingChoice, requireContactCaller, requireContactHuman } from "../federation/authority";
import { profileOwnerActive, readPublicProfile } from "../profiles";
import { consumeLocalRateLimits, consumePublicRateLimits } from "../federation/limits";
import { MAX_PUBLIC_JSON_BYTES } from "../federation/http";
import { PublicFederationError } from "../federation/errors";
import { verifiedHandle } from "../ships/did-directory";
import { ShipXrpcError } from "../ships/errors";
import type { ShipCall } from "../ships/xrpc";
import { authorizeNestedOperation, nestedToolOwner } from "../tool-approval";
import { getConversationById } from "../../shared/utils";
import { stableOpaqueId } from "../../shared/stable-id";
import { approachFingerprint, approachLock, approachThreadId } from "./shared";

const idSchema = z.string().check(z.minLength(1), z.maxLength(128));
const revisionSchema = z.int().check(z.positive());
const createSchema = z.strictObject({
  did: didSchema, profileCid: z.string().check(z.minLength(1), z.maxLength(128)),
  displayName: z.string().check(z.minLength(1), z.maxLength(80)),
  text: z.string().check(z.minLength(1), z.maxLength(32_768)), idempotencyKey: idSchema,
  shipHandlesMessages: z.optional(z.boolean()),
});
/** What a contact's Ship hears once its request is received; a repeated send hears it again. */
const RECEIVED: MessageRequestOutput = { state: "received" };
const UNAVAILABLE = "Message requests are unavailable";

/** The owner's canonical Ship sees only the requests it may send; incoming requests are the human's to read and decide. */
function requireOutgoingForProcess(direction: "incoming" | "outgoing", ctx: KernelContext): void {
  if (ctx.processId && direction !== "outgoing") throw new Error("Incoming message requests require the signed-in human");
}

export function handleApproachGet(args: ApproachGetArgs, ctx: KernelContext): ApproachResult {
  const record = ctx.approaches.owned(idSchema.parse(args.approachId), requireContactCaller(ctx, true));
  requireOutgoingForProcess(record.summary.direction, ctx);
  return { approach: record.summary };
}

export function handleApproachList(args: ApproachListArgs, ctx: KernelContext): ApproachListResult {
  const ownerUid = requireContactCaller(ctx, true);
  const direction = z.enum(["incoming", "outgoing"]).parse(args.direction);
  requireOutgoingForProcess(direction, ctx);
  const status = z.optional(z.enum(["active", "history"])).parse(args.status);
  const limit = args.limit ?? 30;
  const before = args.before ? z.strictObject({ createdAtMs: z.int().check(z.positive()), id: idSchema }).parse(args.before) : undefined;
  const approaches = ctx.approaches.list(ownerUid, { direction, status, limit, before });
  const last = approaches.at(-1);
  return { approaches, ...(last && approaches.length === limit ? { next: { createdAtMs: last.createdAtMs, id: last.id } } : undefined) };
}

export async function handleApproachCreate(input: ApproachCreateArgs, ctx: KernelContext): Promise<ApproachResult> {
  const ownerUid = requireContactCaller(ctx, true);
  const args = createSchema.parse(input);
  contactHandlingChoice(args.shipHandlesMessages, ctx);
  // A message request reaches someone who is not a contact yet, so the Ship asks first
  // unless the owner's approval policy says otherwise. A replay of a request already sent does not ask again.
  if (!ctx.approaches.byIdempotencyKey(ownerUid, args.idempotencyKey)) {
    // A direct process syscall carries no tool owner yet; derive it, as scheduling does, so the
    // Ship's run policy applies however the request arrives. A signed-in human has none and is not asked.
    const toolOwner = nestedToolOwner(ctx);
    if (toolOwner) {
      // The question names the person by handle, and a profile that has changed or closed is refused before anyone is asked.
      const { handle } = await requestableProfile(args, ctx);
      await authorizeNestedOperation({ ...ctx, toolOwner }, "approach.create", jsonObjectSchema.parse({ recipient: handle, ...args }), "ask");
    }
  }
  return await ctx.coordinateFederationContact(`approach-send:${ownerUid}:${args.idempotencyKey}`, () => createApproach(args, ownerUid, ctx));
}

/** The recipient's profile as it stands now: the version its sender read, still open to requests. */
async function requestableProfile(args: z.infer<typeof createSchema>, ctx: KernelContext): Promise<PublicProfile> {
  const profile = await readPublicProfile(args.did, ctx);
  if (profile.cid !== args.profileCid) throw new Error("This profile changed; review it again before sending");
  if (profile.contactPolicy !== "requests") throw new Error("This person is not receiving new message requests");
  return profile;
}

async function createApproach(args: z.infer<typeof createSchema>, ownerUid: number, ctx: KernelContext): Promise<ApproachResult> {
  if (!args.displayName.trim() || !args.text.trim()) throw new Error("Enter your display name and a message");
  const previous = ctx.approaches.byIdempotencyKey(ownerUid, args.idempotencyKey);
  if (previous) {
    const content: SendMessageRequestInput = {
      requestId: previous.summary.requestId, profileCid: args.profileCid, name: args.displayName, messageId: previous.messageId,
      text: args.text, createdAtMs: previous.sentAtMs, expiresAtMs: previous.summary.expiresAtMs,
    };
    if (previous.fingerprint !== await approachFingerprint(content) || previous.summary.peerDid !== args.did
      || previous.shipHandlesMessages !== (args.shipHandlesMessages ?? false)) throw new Error("This send already has different content");
    return { approach: previous.summary };
  }
  // Approval can take a while, so the request is checked against the profile as it stands once approved.
  const profile = await requestableProfile(args, ctx);
  // Sending a message request is one of the Ship's outward acts, so it creates the Ship's DID if need be.
  const ship = await ensureShipAccount(ctx);
  if (ship.did === profile.did) throw new Error("Choose a person on another Ship");
  if (ctx.federation.getByRemote(ownerUid, profile.did)?.state === "active") throw new Error("You already have a conversation with this person");
  const now = Date.now();
  const content: SendMessageRequestInput = sendMessageRequestInputSchema.parse({
    requestId: `request:${crypto.randomUUID()}`, profileCid: profile.cid, name: args.displayName,
    messageId: `msg:${crypto.randomUUID()}`, text: args.text, createdAtMs: now, expiresAtMs: now + APPROACH_LIFETIME_MS,
  });
  // Account for JSON escaping before committing a send that the peer cannot parse.
  if (new TextEncoder().encode(JSON.stringify(content)).length + 1024 > MAX_PUBLIC_JSON_BYTES) {
    throw new Error("This message exceeds the encoded request limit");
  }
  const fingerprint = await approachFingerprint(content);
  const threadId = await approachThreadId(ship.did, content.requestId);
  requireContactCaller(ctx, true);
  const prepared = ctx.federation.transaction(() => {
    const peerContact = ctx.federation.getByRemote(ownerUid, profile.did);
    if (peerContact?.state === "active") throw new Error("You already have a conversation with this person");
    return ctx.approaches.prepare({
      ownerUid, direction: "outgoing", remoteDid: profile.did, remoteHandle: profile.handle,
      remoteDisplayName: profile.displayName, localDisplayName: args.displayName,
      shipHandlesMessages: args.shipHandlesMessages,
      conversationId: peerContact?.conversationId ?? `conv:${crypto.randomUUID()}`, contactId: peerContact?.id ?? `contact:${crypto.randomUUID()}`,
      threadId, content, fingerprint, idempotencyKey: args.idempotencyKey,
    }, () => consumeLocalRateLimits(ctx, [
      { scope: `owner:${ownerUid}`, operation: "approach.outgoing.day", maximum: 10, windowMs: 86_400_000 },
    ], now, "Daily message request limit reached"));
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
  const shipHandlesMessages = decision === "accept" ? contactHandlingChoice(args.shipHandlesMessages, ctx) : false;
  const existing = ctx.approaches.owned(id, ownerUid);
  const record = await ctx.coordinateFederationContact(approachLock(existing), () => ctx.federation.transaction(() => {
    requireContactHuman(ctx);
    if (decision === "accept") return ctx.approaches.beginAcceptance(id, ownerUid, revision, shipHandlesMessages);
    return ctx.approaches.decide(id, ownerUid, revision, decision === "decline" ? "declined" : "withdrawn");
  }));
  await ctx.scheduleApproachMaintenance();
  ctx.broadcastToUserUid(ownerUid, "approach.changed");
  return { approach: record.summary };
}

export async function handleApproachRetry(args: ApproachRetryArgs, ctx: KernelContext): Promise<ApproachResult> {
  const ownerUid = requireContactCaller(ctx, true);
  const id = idSchema.parse(args.approachId);
  requireOutgoingForProcess(ctx.approaches.owned(id, ownerUid).summary.direction, ctx);
  const record = ctx.approaches.retry(id, ownerUid, revisionSchema.parse(args.expectedRevision));
  await ctx.scheduleApproachMaintenance();
  ctx.broadcastToUserUid(ownerUid, "approach.changed");
  return { approach: record.summary };
}

/**
 * `space.ship.sendMessageRequest`: someone who read this Ship's published
 * profile asks to talk. The sender is the DID that signed the call, and the
 * request must name the profile record the Ship publishes now.
 */
export async function receiveMessageRequest(call: ShipCall, ctx: KernelContext): Promise<JsonValue> {
  consumeRequestIngress(ctx);
  const content = sendMessageRequestInputSchema.parse(call.input);
  const sender = call.caller;
  if (sender === ctx.shipIdentity.current()) throw new ShipXrpcError(400, "InvalidRequest", "A Ship can't send itself a message request");
  const published = ctx.profiles.page();
  if (!published || !profileOwnerActive(published.ownerUid, ctx)) throw new PublicFederationError(404, UNAVAILABLE);
  const ownerUid = published.ownerUid;
  const prior = ctx.approaches.byRequest("incoming", sender, content.requestId);
  if (prior && prior.ownerUid !== ownerUid) throw new PublicFederationError(404, UNAVAILABLE);
  const fingerprint = await approachFingerprint(content);
  const remoteHandle = prior ? prior.summary.peerHandle : await verifiedHandle(sender, ctx);
  const threadId = await approachThreadId(sender, content.requestId);
  const existing = ctx.federation.getByRemote(ownerUid, sender);
  const received = ctx.federation.transaction(() => ctx.approaches.prepare({
    ownerUid, direction: "incoming", remoteDid: sender, ...(remoteHandle ? { remoteHandle } : undefined),
    remoteDisplayName: content.name, localDisplayName: published.record.displayName,
    conversationId: prior?.summary.conversationId ?? existing?.conversationId ?? `conv:${crypto.randomUUID()}`,
    contactId: prior?.contactId ?? existing?.id ?? `contact:${crypto.randomUUID()}`, threadId, content, fingerprint,
  }, () => {
    // Only a new request is checked against the profile; a repeat finds the one it sent.
    const current = ctx.profiles.page();
    if (!current || current.ownerUid !== ownerUid || !profileOwnerActive(ownerUid, ctx) || current.cid !== content.profileCid
      || profileContactPolicy(current.record.contactPolicy) !== "requests" || existing?.state === "active") {
      throw new PublicFederationError(404, UNAVAILABLE);
    }
    consumePublicRateLimits(ctx, [
      { scope: `owner:${ownerUid}`, operation: "approach.incoming.hour", maximum: 60, windowMs: 3_600_000 },
      { scope: `owner:${ownerUid}`, operation: "approach.incoming.day", maximum: 100, windowMs: 86_400_000 },
      { scope: "installation", operation: "approach.incoming.day", maximum: 500, windowMs: 86_400_000 },
      { scope: `approach:${ownerUid}:${sender}`, operation: "approach.pair.day", maximum: 5, windowMs: 86_400_000 },
    ], Date.now(), "Message request limit reached");
  }));
  await ctx.scheduleApproachMaintenance();
  await ctx.coordinateFederationContact(approachLock(received), () => appendApproachMessage(received.summary.id, ctx));
  return RECEIVED;
}

/** Every message-request method shares one installation-wide budget for calls. */
export function consumeRequestIngress(ctx: KernelContext): void {
  consumePublicRateLimits(ctx, [{ scope: "installation", operation: "approach.ingress", maximum: 120, windowMs: 60_000 }], Date.now(), "Message request limit reached");
}

export async function appendApproachMessage(id: string, ctx: KernelContext): Promise<void> {
  const record = ctx.approaches.get(id);
  if (!record || record.messageSequence !== null || record.summary.state !== "preparing") return;
  if (!record.pendingText) throw new Error("Message request append payload is unavailable");
  const { summary } = record;
  // The request's first message is the sender's: the other person's for an incoming request, this Ship's for an outgoing one.
  const senderDid = summary.direction === "incoming" ? summary.peerDid : ctx.shipIdentity.current();
  if (!senderDid) throw new Error("This Ship has no DID for the request it sent");
  const conversation = ctx.conversations.ensureContact(record.ownerUid, summary.displayName, summary.conversationId);
  const established = ctx.federation.get(record.contactId);
  const stub = getConversationById(ctx.installationId, conversation.id);
  await stub.initialize({ ownerUid: record.ownerUid, kind: "contact", ...(established ? undefined : { intakeId: id }) });
  const message = await stub.append({
    messageId: await stableOpaqueId("msg", [senderDid, record.messageId]),
    idempotencyKey: `approach:${id}`, text: record.pendingText,
    author: summary.direction === "incoming" ? { kind: "contact", contactId: record.contactId, displayName: summary.displayName } : { kind: "user", uid: record.ownerUid },
    social: { reference: { did: senderDid, messageId: record.messageId }, threadId: record.threadId, provenance: { kind: "human" } },
    origin: summary.direction === "incoming" ? { kind: "federation", contactId: record.contactId, deliveryId: summary.requestId } : { kind: "client" },
    createdAt: record.sentAtMs,
  });
  ctx.approaches.messageCommitted(id, message.message.sequence);
  ctx.conversations.recordContactMessage(message.message, true);
  if (message.created) {
    ctx.broadcastToUserUid(record.ownerUid, "message.committed", { message: message.message, directed: false });
    ctx.broadcastToUserUid(record.ownerUid, "conversation.changed", { conversationId: conversation.id, latestSequence: message.message.sequence });
  }
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
}
