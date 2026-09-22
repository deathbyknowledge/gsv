import {
  contactDraftCreateSchema, resourceBlockSchema, jsonValueSchema,
  type ContactDraftCreateArgs, type ContactDraftDecisionArgs, type ContactDraftGetArgs,
  type ContactDraftListArgs, type ContactDraftListResult, type ContactDraftResult,
} from "@humansandmachines/gsv/protocol";
import { stableOpaqueId } from "@humansandmachines/gsv/protocol/stable-id";
import { getConversationById } from "../shared/utils";
import { hasCapability } from "./capabilities";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";
import { handleContactSend } from "./federation";
import { canonicalJson } from "./federation-crypto";

function draftOwner(ctx: KernelContext): number {
  if (ctx.processId || principalOf(ctx)?.kind !== "human" || ctx.peer?.provenance.kind !== "credential") throw new Error("Draft review requires a signed-in human");
  return resolveCallerOwnerUid(ctx);
}

function recipient(args: Pick<ContactDraftCreateArgs, "contactId" | "expectedGeneration">, ownerUid: number, ctx: KernelContext) {
  const contact = ctx.federation.get(args.contactId);
  if (!contact || contact.ownerUid !== ownerUid || contact.state !== "active" || contact.generation !== args.expectedGeneration) {
    throw new Error("This connection changed; review the recipient again");
  }
  return contact;
}

export async function handleContactDraftCreate(raw: ContactDraftCreateArgs, ctx: KernelContext): Promise<ContactDraftResult> {
  const ownerUid = draftOwner(ctx);
  const args = contactDraftCreateSchema.parse(raw);
  if (new TextEncoder().encode(args.text).byteLength > 32_768 || (!args.text.trim() && !args.media?.length)) throw new Error("Provide a message of at most 32 KiB or selected attachments");
  if ((args.media ?? []).reduce((size, media) => size + media.ref.size, 0) > 48 * 1024 * 1024) throw new Error("Attachments exceed 48 MiB");
  const fingerprint = await stableOpaqueId("contact-draft", [canonicalJson(jsonValueSchema.parse(JSON.parse(JSON.stringify(args))))]);
  const replay = ctx.federation.drafts.replay(ownerUid, args.idempotencyKey, fingerprint);
  if (replay) return { draft: replay };
  recipient(args, ownerUid, ctx);
  const conversation = ctx.conversations.get(args.source.conversationId);
  if (!conversation || conversation.ownerUid !== ownerUid || conversation.kind !== "work") throw new Error("Select a committed reply from your private helper");
  const history = await getConversationById(ctx.installationId, conversation.id).history({ beforeSequence: args.source.sequence + 1, limit: 1 });
  const source = history.messages[0];
  if (!source || source.id !== args.source.messageId || source.sequence !== args.source.sequence || source.author.kind !== "process") {
    throw new Error("The selected helper reply is no longer available");
  }
  const processId = source.author.pid;
  const process = ctx.procs.get(processId);
  const scope = process?.scopeId ? ctx.procs.scopes.get(process.scopeId) : null;
  if (!process || process.ownerUid !== ownerUid || !scope?.policy.conversations.some((grant) => grant.contactId === args.contactId && grant.generation === args.expectedGeneration)) {
    throw new Error("This reply was not prepared by a helper for this conversation");
  }
  const references = [...scope.policy.resources, ...(source.media ?? []).flatMap((media) => {
    const parsed = resourceBlockSchema.safeParse(media);
    return parsed.success ? [parsed.data.ref] : [];
  })];
  for (const media of args.media ?? []) {
    if (!references.some((ref) => canonicalJson(jsonValueSchema.parse(ref)) === canonicalJson(jsonValueSchema.parse(media.ref)))) throw new Error("Review attachments from this helper's reply or its selected materials");
  }
  ctx.requestSignal?.throwIfAborted();
  const draft = ctx.federation.transaction(() => {
    recipient(args, ownerUid, ctx);
    if (ctx.conversations.get(conversation.id)?.ownerUid !== ownerUid) throw new Error("Helper conversation is no longer available");
    return ctx.federation.drafts.create(ownerUid, processId, args, fingerprint);
  });
  ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { draft };
}

export function handleContactDraftGet(args: ContactDraftGetArgs, ctx: KernelContext): ContactDraftResult {
  const draft = ctx.federation.drafts.get(draftOwner(ctx), args.draftId);
  if (!draft) throw new Error("Draft not found");
  return { draft };
}

export function handleContactDraftList(args: ContactDraftListArgs, ctx: KernelContext): ContactDraftListResult {
  return ctx.federation.drafts.list(draftOwner(ctx), args.contactId, args.after ?? "", Math.min(50, Math.max(1, Math.trunc(args.limit ?? 20))));
}

export function handleContactDraftDiscard(args: ContactDraftDecisionArgs, ctx: KernelContext): ContactDraftResult {
  const ownerUid = draftOwner(ctx);
  const draft = ctx.federation.transaction(() => ctx.federation.drafts.decide(ownerUid, args.draftId, args.expectedRevision, "discard"));
  ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { draft };
}

export async function handleContactDraftApprove(args: ContactDraftDecisionArgs, ctx: KernelContext): Promise<ContactDraftResult> {
  const ownerUid = draftOwner(ctx);
  if (!hasCapability(principalOf(ctx)?.calls ?? [], "contact.send")) throw new Error("Your account cannot send contact messages");
  const draft = ctx.federation.transaction(() => ctx.federation.drafts.decide(ownerUid, args.draftId, args.expectedRevision, "approve"));
  if (draft.result) return { draft };
  ctx.broadcastToUserUid(ownerUid, "contact.changed");
  const result = await handleContactSend({
    contactId: draft.content.contactId, expectedGeneration: draft.content.expectedGeneration,
    text: draft.content.text, media: draft.content.media, replyTo: draft.content.replyTo,
    idempotencyKey: `approved:${draft.id}`,
  }, ctx, {
    processId: draft.processId, approvalId: draft.id,
    assertCurrent: () => { ctx.federation.drafts.assertSending(ownerUid, draft.id); },
  });
  const sent = ctx.federation.transaction(() => ctx.federation.drafts.sent(ownerUid, draft.id, result));
  ctx.broadcastToUserUid(ownerUid, "contact.changed");
  return { draft: sent };
}
