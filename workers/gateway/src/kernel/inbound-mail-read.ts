import type {
  MailListArgs,
  MailListResult,
  MailMessageSummary,
  MailReadArgs,
  MailReadResult,
  MailSearchArgs,
  MailSearchResult,
} from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { createNativeFileSystem } from "../drivers/native/filesystem";
import type { GsvFs } from "../fs/gsv-fs";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { MailMessagePage, MailMessageRecord } from "./mailbox-store";

// A model reads this inline; a longer message stays whole at its text path.
const MAIL_READ_TEXT_CHARS = 100_000;

const pageArgsSchema = z.object({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  before: z.optional(z.string().check(z.minLength(1), z.maxLength(600))),
});
const searchArgsSchema = z.extend(pageArgsSchema, { query: z.string() });
const readArgsSchema = z.object({ messageId: z.string().check(z.minLength(1), z.maxLength(300)) });

export function handleMailList(value: MailListArgs, ctx: KernelContext): MailListResult {
  const args = parseArgs(pageArgsSchema, value ?? {}, "mail.list");
  return publicPage(ctx.mailboxes.list(resolveCallerOwnerUid(ctx), args));
}

export function handleMailSearch(value: MailSearchArgs, ctx: KernelContext): MailSearchResult {
  const { query, ...page } = parseArgs(searchArgsSchema, value, "mail.search");
  return publicPage(ctx.mailboxes.search(resolveCallerOwnerUid(ctx), query, page));
}

export async function handleMailRead(
  value: MailReadArgs,
  ctx: KernelContext,
  fs: GsvFs = createNativeFileSystem(ctx),
): Promise<MailReadResult> {
  const { messageId } = parseArgs(readArgsSchema, value, "mail.read");
  const message = ctx.mailboxes.getMessage(resolveCallerOwnerUid(ctx), messageId.trim());
  if (!message) throw new Error(`Mail message not found: ${messageId}`);
  const text = await fs.readFile(message.textPath);
  return {
    message: {
      ...publicSummary(message),
      to: message.to,
      cc: message.cc,
      replyTo: message.replyTo,
      attachments: message.attachments.map(({ filename, mimeType, size }) => (
        filename === undefined ? { mimeType, size } : { filename, mimeType, size }
      )),
      text: text.slice(0, MAIL_READ_TEXT_CHARS),
      truncated: text.length > MAIL_READ_TEXT_CHARS,
      textPath: message.textPath,
      rawPath: message.rawPath,
    },
  };
}

function publicPage(page: MailMessagePage): MailListResult {
  const messages = page.messages.map(publicSummary);
  return page.next === undefined ? { messages } : { messages, next: page.next };
}

function publicSummary(message: MailMessageRecord): MailMessageSummary {
  return {
    messageId: message.messageId,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    from: message.displayFrom ?? message.envelopeFrom,
    subject: message.subject,
    summary: message.summary,
    category: message.category,
    requiresAttention: message.requiresAttention,
    attachmentCount: message.attachments.length,
  };
}

function parseArgs<T>(schema: z.ZodMiniType<T>, value: T, call: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${call}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
