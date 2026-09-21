import { z } from "zod/mini";
import type {
  ConversationInboxArgs, ConversationInboxResult, ConversationViewUpdateArgs, ConversationViewUpdateResult, ConversationViewGetArgs, ConversationViewGetResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { requireContactHuman } from "./federation/authority";

const conversationIdSchema = z.string().check(z.minLength(1), z.maxLength(256));
const sequenceSchema = z.int().check(z.minimum(0));
const inboxArgsSchema = z.strictObject({
  archived: z.optional(z.boolean()),
  before: z.optional(z.strictObject({ updatedAt: sequenceSchema, conversationId: conversationIdSchema })),
  limit: z.optional(z.int().check(z.minimum(1), z.maximum(100))),
});
const viewUpdateArgsSchema = z.strictObject({
  conversationId: conversationIdSchema,
  readThroughSequence: z.optional(sequenceSchema),
  archived: z.optional(z.boolean()),
  expectedRevision: z.optional(z.int().check(z.minimum(1))),
});

export function handleConversationInbox(args: ConversationInboxArgs, ctx: KernelContext): ConversationInboxResult {
  const ownerUid = requireContactHuman(ctx);
  const input = inboxArgsSchema.parse(args);
  const limit = input.limit ?? 30;
  const entries = ctx.conversations.inbox(ownerUid, { ...input, limit });
  const last = entries.at(-1);
  return { entries, ...(last && entries.length === limit ? {
    next: { updatedAt: last.conversation.updatedAt, conversationId: last.conversation.id },
  } : undefined) };
}

export function handleConversationViewGet(args: ConversationViewGetArgs, ctx: KernelContext): ConversationViewGetResult {
  const ownerUid = requireContactHuman(ctx);
  const id = conversationIdSchema.parse(args.conversationId);
  const entry = ctx.conversations.inboxEntry(ownerUid, id);
  if (!entry) throw new Error("Conversation not found");
  return { entry };
}

export function handleConversationViewUpdate(args: ConversationViewUpdateArgs, ctx: KernelContext): ConversationViewUpdateResult {
  const ownerUid = requireContactHuman(ctx);
  const input = viewUpdateArgsSchema.parse(args);
  const previous = ctx.conversations.inboxEntry(ownerUid, input.conversationId);
  const entry = ctx.conversations.updateView(ownerUid, input);
  if (previous?.view.revision !== entry.view.revision) ctx.broadcastToUserUid(ownerUid, "conversation.changed", {
    viewOnly: true, conversationId: entry.conversation.id, latestSequence: entry.conversation.latestSequence,
  });
  return { entry };
}
