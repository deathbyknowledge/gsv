import type { SendMessageRequestInput } from "@humansandmachines/gsv/protocol";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import type { FederationContactRecord } from "../federation-store";
import { canonicalJson, sha256Base64Url } from "../federation-crypto";
import { PublicFederationError } from "../federation/errors";
import { profileOwnerActive } from "../profiles";

export function approachLock(record: ApproachRecord): string {
  return `pairing:${record.ownerUid}:${record.summary.peerDid}`;
}

/** What a repeated send must match: the request exactly as its sender's Ship sends it. */
export async function approachFingerprint(content: SendMessageRequestInput): Promise<string> {
  return sha256Base64Url(canonicalJson(jsonValueSchema.parse(content)));
}

/** The thread a request starts, which both Ships derive from its sender's DID and ID for it. */
export async function approachThreadId(senderDid: string, requestId: string): Promise<string> {
  return `thread:${await sha256Base64Url(`message-request-thread\n${senderDid}\n${requestId}`)}`;
}

export function requireApproachAvailable(record: ApproachRecord, ctx: KernelContext): ApproachRecord {
  const current = ctx.approaches.get(record.summary.id);
  if (!current || !profileOwnerActive(current.ownerUid, ctx)
    || ctx.federation.isBlocked(current.ownerUid, current.summary.peerDid)
    || ["blocked", "declined", "withdrawn", "expired"].includes(current.summary.state)) {
    throw new PublicFederationError(410, "Message request is no longer available");
  }
  return current;
}

/** The contact an accepted request made, while it is still that connection. */
export function requireApproachContact(record: ApproachRecord, ctx: KernelContext): FederationContactRecord {
  const contact = ctx.federation.get(record.contactId);
  if (!contact || contact.ownerUid !== record.ownerUid || contact.state !== "active" || contact.generation !== record.generation
    || contact.remoteDid !== record.summary.peerDid || contact.conversationId !== record.summary.conversationId || contact.threadId !== record.threadId) {
    throw new PublicFederationError(410, "This connection has been replaced or removed");
  }
  return contact;
}
