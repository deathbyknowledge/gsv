import type {
  AcceptInvitationOutput,
  ContactInviteAcceptArgs,
  ContactInviteAcceptResult,
  ContactInviteCancelArgs,
  ContactInviteCancelResult,
  ContactInviteCreateArgs,
  ContactInviteCreateResult,
  ContactInviteListArgs,
  ContactInviteListResult,
  ContactInviteSummary,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  ACCEPT_INVITATION,
  acceptInvitationInputSchema,
  acceptInvitationOutputSchema,
  contactInvitationUrl,
  encodeContactInvitation,
  parseContactInvitation,
} from "@humansandmachines/gsv/protocol";
import { ensureShipAccount, ensureShipDid } from "../atproto";
import type { KernelContext } from "../context";
import { ensureContactConversation } from "../federation";
import { randomBase64Url, sha256Base64Url } from "../federation-crypto";
import type { FederationContactRecord, FederationInviteRecord } from "../federation-store";
import { personName } from "../profiles";
import { resolveHandle, verifiedHandle } from "../ships/did-directory";
import { ShipCallError, ShipXrpcError } from "../ships/errors";
import { callShipProcedure, type ShipCall } from "../ships/xrpc";
import { contactHandlingChoice, contactSummary, requireContactCaller, requireOwnedActiveContactGeneration } from "./authority";
import { isTerminalFederationError } from "./delivery";
import { FederationHttpError } from "./errors";
import {
  assertContactCapacity,
  consumeLocalRateLimits,
  pruneFederationState,
  RECEIPT_RETENTION_MS,
} from "./limits";
import {
  activateFederationContact,
  assertPairingAttemptCanContinue,
  assertPairingAttemptIdentity,
  requireCommittedPairingContact,
} from "./pairing";
import { isCurrentFederationContact } from "./resources";

const DEFAULT_INVITE_LIFETIME_MS = 60 * 60_000;
const MAX_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_OUTSTANDING_INVITES_PER_OWNER = 20;
const MAX_INVITES_CREATED_PER_HOUR = 20;

/** What the person accepting an invitation reads when the inviting Ship refuses, by the error it names. */
const REFUSALS = new Map([
  ["InvitationNotFound", "This invitation isn't available. Ask for a new one."],
  ["InvitationExpired", "This invitation has expired. Ask for a new one."],
  ["InvitationCancelled", "This invitation was cancelled."],
  ["InvitationUsed", "This invitation was already used."],
]);

type Acceptance = { contact: FederationContactRecord; changed: boolean };

export async function handleContactInviteCreate(
  args: ContactInviteCreateArgs,
  ctx: KernelContext,
): Promise<ContactInviteCreateResult> {
  const ownerUid = requireContactCaller(ctx, true);
  const shipHandlesMessages = contactHandlingChoice(args.shipHandlesMessages, ctx);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const expiresInSeconds = args.expiresInSeconds ?? DEFAULT_INVITE_LIFETIME_MS / 1_000;
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("Invite lifetime must be a positive whole number of seconds");
  }
  const lifetimeMs = expiresInSeconds * 1_000;
  if (lifetimeMs > MAX_INVITE_LIFETIME_MS) {
    throw new Error("Invite lifetime exceeds seven days");
  }
  const name = personName(ownerUid, ctx);
  const ship = await ensureShipAccount(ctx);
  const token = randomBase64Url(32);
  const tokenHash = await sha256Base64Url(token);
  const expiresAtMs = now + lifetimeMs;
  const invite = ctx.federation.transaction(() => {
    if (ctx.federation.outstandingInviteCount(ownerUid, now) >= MAX_OUTSTANDING_INVITES_PER_OWNER) {
      throw new Error("Outstanding contact invite limit reached");
    }
    consumeLocalRateLimits(ctx, [{
      scope: `owner:${ownerUid}`,
      operation: "invite.create",
      maximum: MAX_INVITES_CREATED_PER_HOUR,
      windowMs: 60 * 60_000,
    }], now, "Contact invite rate limit reached");
    return ctx.federation.createInvite({ ownerUid, shipHandlesMessages, tokenHash, expiresAtMs, now });
  });
  const code = encodeContactInvitation({ version: 2, did: ship.did, handle: ship.handle, name, token, expiresAtMs });
  ctx.broadcastToUserUid(ownerUid, "contact.invite.changed");
  const origin = ctx.installationIdentity?.canonicalOrigin;
  const url = contactInvitationUrl(code, ctx.env.GSV_OWNER_SIGNUP_URL ?? `${origin}/connect`);
  return { inviteId: invite.inviteId, code, url, expiresAtMs };
}

export function handleContactInviteList(
  args: ContactInviteListArgs,
  ctx: KernelContext,
): ContactInviteListResult {
  const ownerUid = requireContactCaller(ctx, false);
  const now = Date.now();
  pruneFederationState(ctx, now);
  return {
    invites: ctx.federation
      .listInvites(ownerUid, args.includeTerminal ?? false, now)
      .map((invite) => contactInviteSummary(invite, now)),
  };
}

export function handleContactInviteCancel(
  args: ContactInviteCancelArgs,
  ctx: KernelContext,
): ContactInviteCancelResult {
  const ownerUid = requireContactCaller(ctx, true);
  const now = Date.now();
  const inviteId = args.inviteId.trim();
  if (!inviteId.startsWith("invite:")) throw new Error("Contact invite id is invalid");
  const previous = ctx.federation.invite(inviteId);
  const invite = ctx.federation.cancelInvite(inviteId, ownerUid, now);
  if (previous?.state !== invite.state) ctx.broadcastToUserUid(ownerUid, "contact.invite.changed");
  return { invite: contactInviteSummary(invite, now) };
}

/**
 * Accepts another person's invitation by calling the Ship its code names. The
 * code's address must name that Ship's DID back, and the contact is the DID
 * the inviting Ship answered as.
 */
export async function handleContactInviteAccept(
  args: ContactInviteAcceptArgs,
  ctx: KernelContext,
): Promise<ContactInviteAcceptResult> {
  ctx.requestSignal?.throwIfAborted();
  const ownerUid = requireContactCaller(ctx, true);
  contactHandlingChoice(args.shipHandlesMessages, ctx);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const { invitation } = parseContactInvitation(args.code);
  const tokenHash = await sha256Base64Url(invitation.token);
  const expected = { ownerUid, expiresAtMs: invitation.expiresAtMs, remoteDid: invitation.did };
  const recorded = ctx.federation.pairingAttempt(tokenHash);
  if (recorded) {
    assertPairingAttemptIdentity(recorded, expected);
    assertPairingAttemptCanContinue(recorded);
    if (recorded.state === "committed") {
      const committed = requireCommittedPairingContact(recorded, ctx);
      await ensureContactConversation(committed, ctx);
      return { contact: contactSummary(committed) };
    }
  } else if (invitation.expiresAtMs <= now) {
    throw new Error("This invitation has expired. Ask for a new one.");
  }
  if (invitation.did === await ensureShipDid(ctx)) throw new Error("This invitation is from your own Ship");
  const inviter = await resolveHandle(invitation.handle, ctx);
  if (inviter.did !== invitation.did) throw new Error("This invitation's address doesn't belong to the Ship that sent it");
  assertContactCapacity(ownerUid, invitation.did, ctx);
  const attempt = ctx.federation.transaction(() => ctx.federation.beginPairingAttempt({
    tokenHash,
    ...expected,
    shipHandlesMessages: args.shipHandlesMessages,
    now: Date.now(),
  }));
  assertPairingAttemptCanContinue(attempt);
  if (attempt.state === "committed") {
    const committed = requireCommittedPairingContact(attempt, ctx);
    await ensureContactConversation(committed, ctx);
    return { contact: contactSummary(committed) };
  }
  ctx.requestSignal?.throwIfAborted();
  let accepted: AcceptInvitationOutput;
  try {
    accepted = acceptInvitationOutputSchema.parse(await callShipProcedure(
      invitation.did,
      ACCEPT_INVITATION,
      { token: invitation.token, name: personName(ownerUid, ctx) },
      ctx,
    ));
  } catch (error) {
    if (error instanceof FederationHttpError && isTerminalFederationError(error)) {
      ctx.federation.terminatePairingAttempt(tokenHash, `remote-rejected:${error.status}`);
    }
    const refusal = error instanceof ShipCallError && error.error ? REFUSALS.get(error.error) : undefined;
    if (refusal) throw new Error(refusal, { cause: error });
    throw error;
  }
  const activate = (): Acceptance => ctx.federation.transaction(() => {
    const current = ctx.federation.pairingAttempt(tokenHash);
    if (!current) throw new Error("Contact pairing attempt not found");
    assertPairingAttemptIdentity(current, expected);
    assertPairingAttemptCanContinue(current);
    if (current.state === "committed") {
      if (current.generation !== accepted.generation || current.threadId !== accepted.threadId) {
        throw new Error("Contact acceptance changed after it was committed");
      }
      return { contact: requireCommittedPairingContact(current, ctx), changed: false };
    }
    assertContactCapacity(ownerUid, invitation.did, ctx);
    const contact = activateFederationContact({
      ownerUid,
      remoteDid: invitation.did,
      remoteName: accepted.name,
      ...(inviter.handle ? { remoteHandle: inviter.handle } : undefined),
      generation: accepted.generation,
      threadId: accepted.threadId,
      pairingAttemptTokenHash: tokenHash,
      shipHandlesMessages: current.shipHandlesMessages,
      now: Date.now(),
    }, ctx);
    ctx.federation.commitPairingAttempt({
      tokenHash,
      contactId: contact.id,
      generation: accepted.generation,
      threadId: accepted.threadId,
    });
    return { contact, changed: true };
  });
  const { contact, changed } = await ctx.coordinateFederationContact(`pairing:${ownerUid}:${invitation.did}`, activate);
  if (changed) ctx.broadcastToUserUid(ownerUid, "contact.changed");
  await ensureContactConversation(contact, ctx);
  await ctx.reconcileResponsibilityWake(ownerUid);
  return { contact: contactSummary(requireOwnedActiveContactGeneration(contact, ownerUid, ctx)) };
}

/**
 * `space.ship.acceptInvitation`: the calling Ship accepts an invitation this
 * Ship issued. Whoever holds the code chooses only the name it gives; the
 * contact is the DID that signed the call, and a replay must come from it.
 */
export async function acceptInvitation(call: ShipCall, ctx: KernelContext): Promise<JsonValue> {
  const input = acceptInvitationInputSchema.parse(call.input);
  const tokenHash = await sha256Base64Url(input.token);
  const invite = ctx.federation.inviteByTokenHash(tokenHash);
  assertAcceptable(invite, call.caller, Date.now());
  pruneFederationState(ctx, Date.now());
  if (call.caller === ctx.shipIdentity.current()) {
    throw new ShipXrpcError(400, "InvalidRequest", "A Ship can't accept its own invitation");
  }
  const remoteHandle = await verifiedHandle(call.caller, ctx);
  const generation = `generation:${randomBase64Url(24)}`;
  const threadId = `thread:${await sha256Base64Url(`federation-thread\n${input.token}`)}`;
  const claim = (): Acceptance => ctx.federation.transaction(() => {
    const current = ctx.federation.inviteByTokenHash(tokenHash);
    const now = Date.now();
    assertAcceptable(current, call.caller, now);
    if (current.state === "accepted") {
      const contact = ctx.federation.get(current.acceptedContactId);
      if (
        !contact
        || contact.state !== "active"
        || contact.remoteDid !== call.caller
        || contact.generation !== current.acceptedGeneration
        || contact.threadId !== current.acceptedThreadId
      ) {
        throw new ShipXrpcError(410, "InvitationUsed", "The connection this invitation made has since ended");
      }
      return { contact, changed: false };
    }
    if (ctx.auth.isAccountDisabled(current.ownerUid) || ctx.federation.isBlocked(current.ownerUid, call.caller)) {
      throw new ShipXrpcError(404, "InvitationNotFound", "There's no such invitation");
    }
    assertContactCapacity(current.ownerUid, call.caller, ctx, true);
    const contact = activateFederationContact({
      ownerUid: current.ownerUid,
      shipHandlesMessages: current.shipHandlesMessages,
      generation,
      remoteDid: call.caller,
      remoteName: input.name,
      ...(remoteHandle ? { remoteHandle } : undefined),
      threadId,
      now,
    }, ctx);
    if (!ctx.federation.acceptInvite({ tokenHash, remoteDid: call.caller, contactId: contact.id, generation, threadId, now })) {
      throw new ShipXrpcError(409, "InvitationUsed", "This invitation was already used");
    }
    return { contact, changed: true };
  });
  const { contact, changed } = await ctx.coordinateFederationContact(`pairing:${invite.ownerUid}:${call.caller}`, claim);
  if (changed) {
    ctx.broadcastToUserUid(contact.ownerUid, "contact.changed");
    ctx.broadcastToUserUid(contact.ownerUid, "contact.invite.changed");
  }
  await ensureContactConversation(contact, ctx);
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
  if (!isCurrentFederationContact(contact.id, contact.generation, ctx)) {
    throw new ShipXrpcError(409, "InvitationUsed", "The connection changed while it was being made");
  }
  const output: AcceptInvitationOutput = {
    name: personName(contact.ownerUid, ctx),
    generation: contact.generation,
    threadId: contact.threadId,
  };
  return output;
}

/** An invitation the caller may accept now: issued and unexpired, or already accepted by this same caller. */
function assertAcceptable(
  invite: FederationInviteRecord | null,
  caller: string,
  now: number,
): asserts invite is FederationInviteRecord {
  if (!invite) throw new ShipXrpcError(404, "InvitationNotFound", "There's no such invitation");
  if (invite.state === "cancelled") throw new ShipXrpcError(410, "InvitationCancelled", "This invitation was cancelled");
  if (invite.state === "issued" && invite.expiresAtMs <= now) {
    throw new ShipXrpcError(410, "InvitationExpired", "This invitation has expired");
  }
  if (invite.state === "accepted" && (invite.acceptedRemoteDid !== caller || invite.acceptedAtMs <= now - RECEIPT_RETENTION_MS)) {
    throw new ShipXrpcError(409, "InvitationUsed", "This invitation was already used");
  }
}

function contactInviteSummary(
  invite: FederationInviteRecord,
  now: number,
): ContactInviteSummary {
  const base = {
    inviteId: invite.inviteId,
    expiresAtMs: invite.expiresAtMs,
    createdAtMs: invite.createdAtMs,
  };
  if (invite.state === "accepted") {
    return {
      ...base,
      state: "accepted",
      acceptedAtMs: invite.acceptedAtMs,
      contactId: invite.acceptedContactId,
      remoteDid: invite.acceptedRemoteDid,
    };
  }
  if (invite.state === "cancelled") {
    return { ...base, state: "cancelled", cancelledAtMs: invite.cancelledAtMs };
  }
  return { ...base, state: invite.expiresAtMs <= now ? "expired" : "pending" };
}
