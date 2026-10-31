import type {
  ConversationMessage,
  MessageAttachment,
  ProcHistoryMessageQuote,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
  exceptionDiagnostics,
  sanitizeExceptionDiagnostics,
  type ExceptionDiagnostics,
} from "@humansandmachines/gsv/telemetry";
import { getConversationById } from "../shared/utils";
import type { AdapterMessageRef, AdapterMessageScope } from "./adapter-message-refs";
import type { KernelContext } from "./context";

/**
 * About 250 tokens: a typical Ship reply whole, or enough of a long one to tell which
 * thing the person means. It stays in Process history for the life of the message.
 */
export const QUOTE_TEXT_LIMIT = 1_000;
const QUOTE_TRANSCRIPTION_LIMIT = 300;
const QUOTE_FILENAME_LIMIT = 120;
/**
 * Long enough for a Conversation that has to wake, or read an archive segment, and short
 * enough that a stuck one cannot hold a person's message back. Ingress waits for nothing else here.
 */
export const QUOTE_LOOKUP_TIMEOUT_MS = 2_000;

const UNAVAILABLE: ProcHistoryMessageQuote = { state: "unavailable" };

type QuoteOutcome = "resolved" | "unmapped" | "unavailable" | "failed" | "timed_out";

/**
 * Finds what an inbound message quotes. Runs only for a message with a reply id, before the
 * Process receives it, and never throws or stalls: a failed lookup costs the model the quote,
 * never the person their message.
 */
export async function resolveAdapterQuote(
  ctx: KernelContext,
  scope: AdapterMessageScope,
  replyToId: string,
): Promise<ProcHistoryMessageQuote> {
  const startedAt = Date.now();
  const finish = (outcome: QuoteOutcome, quote: ProcHistoryMessageQuote, diagnostics?: ExceptionDiagnostics) => {
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.quote.resolved",
        properties: {
          ...(diagnostics ? sanitizeExceptionDiagnostics(diagnostics) : undefined),
          adapter: scope.adapter,
          surface: scope.surface.kind,
          outcome,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    return quote;
  };
  try {
    const ref = ctx.adapters.messageRefs.lookup(scope, replyToId);
    if (!ref) return finish("unmapped", UNAVAILABLE);
    const conversation = ctx.conversations.get(ref.conversationId);
    if (conversation?.ownerUid !== scope.ownerUid) return finish("unavailable", UNAVAILABLE);
    const message = await withTimeout(
      getConversationById(ctx.installationId, ref.conversationId)
        .readMessage({ sequence: ref.sequence, messageId: ref.messageId }),
    );
    if (message === TIMED_OUT) return finish("timed_out", UNAVAILABLE);
    if (!message) return finish("unavailable", UNAVAILABLE);
    const author = quoteAuthor(ctx, message, conversation.kind);
    if (!author) return finish("unavailable", UNAVAILABLE);
    return finish("resolved", buildQuote(message, author, ref));
  } catch (error) {
    return finish("failed", UNAVAILABLE, exceptionDiagnostics(error));
  }
}

function quoteAuthor(
  ctx: KernelContext,
  message: Pick<ConversationMessage, "author">,
  conversationKind: string,
): "person" | "ship" | "agent" | null {
  switch (message.author.kind) {
    case "user": return "person";
    case "process":
      return conversationKind === "ship" || ctx.procs.get(message.author.pid)?.isPersonalController
        ? "ship"
        : "agent";
    // A contact's message reaches a messenger only as a notice, which is not this message.
    case "contact": return null;
  }
}

function buildQuote(
  message: Pick<ConversationMessage, "text" | "media">,
  author: "person" | "ship" | "agent",
  ref: AdapterMessageRef,
): ProcHistoryMessageQuote {
  const quote: Extract<ProcHistoryMessageQuote, { state: "resolved" }> = {
    state: "resolved",
    author,
    text: excerpt(message.text, ref.part),
  };
  const media = message.media?.map(quotedMedia);
  if (media?.length) quote.media = media;
  if (ref.part) quote.part = ref.part;
  return quote;
}

/** The start of the text, or for a part of a split message the stretch about where that part falls. */
function excerpt(text: string, part: AdapterMessageRef["part"]): string {
  if (text.length <= QUOTE_TEXT_LIMIT) return text;
  const characters = [...text];
  if (characters.length <= QUOTE_TEXT_LIMIT) return text;
  const proportional = part ? Math.floor((characters.length * part.index) / part.count) : 0;
  const start = Math.min(proportional, characters.length - QUOTE_TEXT_LIMIT);
  const end = start + QUOTE_TEXT_LIMIT;
  return `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

function quotedMedia(item: MessageAttachment): NonNullable<Extract<ProcHistoryMessageQuote, { state: "resolved" }>["media"]>[number] {
  const type = item.type === "resource"
    ? item.mediaType ?? mediaTypeOfContent(item.ref.contentType)
    : item.type;
  const filename = item.filename?.replace(/\s+/g, " ").trim().slice(0, QUOTE_FILENAME_LIMIT);
  const transcription = item.transcription?.trim();
  return {
    type,
    ...(filename ? { filename } : undefined),
    ...(transcription ? { transcription: excerptTranscription(transcription) } : undefined),
  };
}

function excerptTranscription(transcription: string): string {
  const characters = [...transcription];
  return characters.length <= QUOTE_TRANSCRIPTION_LIMIT
    ? transcription
    : `${characters.slice(0, QUOTE_TRANSCRIPTION_LIMIT).join("")}…`;
}

function mediaTypeOfContent(contentType: string): "image" | "audio" | "video" | "document" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

const TIMED_OUT = Symbol("timed out");

async function withTimeout<T>(operation: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), QUOTE_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
