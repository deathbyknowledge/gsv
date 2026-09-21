import * as z from "zod/mini";
import { resourceBlockSchema, type ResourceBlock } from "./resource";
import { originMessageRefSchema, type OriginMessageRef } from "./social-identity";
import type { ContactSendResult } from "./syscalls/contact";

export type ContactDraftCreateArgs = {
  contactId: string;
  expectedGeneration: string;
  source: { conversationId: string; messageId: string; sequence: number };
  text: string;
  media?: ResourceBlock[];
  replyTo?: OriginMessageRef;
  idempotencyKey: string;
};
const id = z.string().check(z.minLength(1), z.maxLength(256));
export const contactDraftCreateSchema: z.ZodMiniType<ContactDraftCreateArgs> = z.strictObject({
  contactId: id, expectedGeneration: id,
  source: z.strictObject({ conversationId: id, messageId: id, sequence: z.int().check(z.positive()) }),
  text: z.string().check(z.maxLength(32_768)),
  media: z.optional(z.array(resourceBlockSchema).check(z.maxLength(16))),
  replyTo: z.optional(originMessageRefSchema),
  idempotencyKey: z.string().check(z.minLength(1), z.maxLength(160)),
});

/** Immutable reviewed content. Editing creates a new draft and requires new consent. */
export type ContactDraft = {
  id: string;
  ownerUid: number;
  processId: string;
  revision: number;
  state: "review" | "sending" | "sent" | "discarded" | "expired";
  content: ContactDraftCreateArgs;
  createdAtMs: number;
  expiresAtMs: number;
  result?: ContactSendResult;
};
export type ContactDraftResult = { draft: ContactDraft };
export type ContactDraftGetArgs = { draftId: string };
export type ContactDraftListArgs = { contactId: string; after?: string; limit?: number };
export type ContactDraftListResult = { drafts: ContactDraft[]; next?: string };
export type ContactDraftDecisionArgs = { draftId: string; expectedRevision: number };
