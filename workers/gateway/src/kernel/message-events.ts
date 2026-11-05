import { z } from "zod";
import {
  procHistoryMessageQuoteSchema, resourceBlockSchema,
  type ConversationMessage, type InteractionOrigin, type ProcHistoryMessageQuote, type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import { interactionOriginSchema } from "../process/internal/schemas";
import type { ProcessInput } from "../protocol/process-frames";
import { getConversationById } from "../shared/utils";
import { deliveryId, processConsumer, shipConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { EventActor, EventInput, LoggedEvent } from "./events/store";

/** A person's message: it stops the run its process is in and starts its own, on the person lane. */
export const MESSAGE_RECEIVED = "message.received";
/** Another process's message: it takes a run of its own once the active one ends. */
export const PROCESS_MESSAGE = "process.message";

const bodySchema = z.strictObject({
  /** The process it is for; absent for the owner's Ship, which takes it whatever its pid. */
  pid: z.string().optional(),
  /** The run a Conversation recorded before delivery; otherwise the run takes the delivery's id. */
  runId: z.string().optional(),
  origin: z.custom<InteractionOrigin>((value) => interactionOriginSchema.safeParse(value).success).optional(),
  /** What a messenger message quoted, as its Conversation could show it then; capped well within the body. */
  quote: z.custom<ProcHistoryMessageQuote>((value) => procHistoryMessageQuoteSchema.safeParse(value).success).optional(),
  content: z.discriminatedUnion("kind", [
    // A committed message, read from its Conversation: chat text has no size limit.
    z.strictObject({
      kind: z.literal("conversation"),
      conversationId: z.string(),
      messageId: z.string(),
      sequence: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("inline"),
      message: z.string(),
      media: z.array(z.custom<ResourceBlock>((value) => resourceBlockSchema.safeParse(value).success)).optional(),
      selectedTarget: z.string().optional(),
    }),
  ]),
});

type Content = Pick<ProcessInput, "message" | "media" | "selectedTarget">;

/**
 * What a committed message hands its process. Its producer passes this to the delivery it
 * makes in its own call, so that attempt needn't read the message back.
 */
export function committedContent(message: Pick<ConversationMessage, "text" | "media" | "selectedTarget">): Content {
  return {
    message: message.text,
    ...(message.media?.length ? { media: message.media } : undefined),
    ...(message.selectedTarget === undefined ? undefined : { selectedTarget: message.selectedTarget }),
  };
}

function messageBody(event: Pick<EventInput, "body">) {
  return bodySchema.parse(event.body);
}

function messageConsumer(event: Pick<EventInput, "ownerUid" | "body">): string {
  const { pid } = messageBody(event);
  return pid === undefined ? shipConsumer(event.ownerUid) : processConsumer(pid);
}

/** The run a message takes: the one its Conversation recorded, or its delivery's id. */
export function messageRunId(event: LoggedEvent): string {
  return messageBody(event).runId ?? deliveryId(event.id, messageConsumer(event));
}

/**
 * A message committed to a Conversation, from a client or a messenger, for the process that
 * handles it: the owner's Ship, or the process a work or group conversation belongs to. Its key
 * is the message's id, so a resend or an adapter's retry appends nothing. The Conversation
 * recorded the run first, and replies are matched by it.
 */
export function conversationMessage(input: {
  ownerUid: number;
  /** Absent for the Ship's conversation. */
  pid?: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  runId: string;
  origin?: InteractionOrigin;
  quote?: ProcHistoryMessageQuote;
  actor: EventActor;
}): EventInput {
  return {
    type: MESSAGE_RECEIVED,
    ownerUid: input.ownerUid,
    subject: `conversation:${input.conversationId}`,
    actor: input.actor,
    key: input.messageId,
    body: {
      ...(input.pid === undefined ? undefined : { pid: input.pid }),
      runId: input.runId,
      ...(input.origin === undefined ? undefined : { origin: input.origin }),
      ...(input.quote === undefined ? undefined : { quote: input.quote }),
      content: { kind: "conversation", conversationId: input.conversationId, messageId: input.messageId, sequence: input.sequence },
    },
  };
}

/**
 * A message sent straight to a process, or the prompt it was spawned with, carried inline. One
 * from another process or a schedule waits its turn; any other stops the process's run.
 */
export function directMessage(input: {
  ownerUid: number;
  pid: string;
  message: string;
  media?: ResourceBlock[];
  selectedTarget?: string;
  origin?: InteractionOrigin;
  actor: EventActor;
}): EventInput {
  const fromProcess = input.origin?.kind === "process" || input.origin?.kind === "scheduler";
  return {
    type: fromProcess ? PROCESS_MESSAGE : MESSAGE_RECEIVED,
    ownerUid: input.ownerUid,
    subject: `proc:${input.pid}`,
    actor: input.actor,
    key: crypto.randomUUID(),
    body: {
      pid: input.pid,
      ...(input.origin === undefined ? undefined : { origin: input.origin }),
      content: {
        kind: "inline",
        message: input.message,
        ...(input.media?.length ? { media: input.media } : undefined),
        ...(input.selectedTarget === undefined ? undefined : { selectedTarget: input.selectedTarget }),
      },
    },
  };
}

function messageDefinition(busy: "interrupt" | "after"): EventDefinition<Content> {
  return {
    // A person's message never waits behind its process's background events.
    routes: (event) => [{ consumer: messageConsumer(event), lane: busy === "interrupt" ? "person" : "background" }],
    async prepare(event, ctx) {
      const { content } = messageBody(event);
      if (content.kind === "inline") {
        return {
          message: content.message,
          ...(content.media ? { media: content.media } : undefined),
          ...(content.selectedTarget === undefined ? undefined : { selectedTarget: content.selectedTarget }),
        };
      }
      const message = await getConversationById(ctx.installationId, content.conversationId)
        .readMessage({ sequence: content.sequence, messageId: content.messageId });
      if (!message) return { withdrawn: "the message is no longer in its conversation" };
      return committedContent(message);
    },
    admit(event, content) {
      const body = messageBody(event);
      return {
        input: {
          ...content,
          ...(body.origin === undefined ? undefined : { origin: body.origin }),
          ...(body.content.kind === "conversation"
            ? { interaction: { conversationId: body.content.conversationId, messageId: body.content.messageId } }
            : undefined),
          ...(body.quote === undefined ? undefined : { quote: body.quote }),
          ...(body.runId === undefined ? undefined : { runId: body.runId }),
        },
        admission: { idle: "start", busy },
      };
    },
    // A message that never reached its process leaves no reply route behind.
    async settled(event, ctx, end) {
      if (end.state !== "delivered") ctx.runRoutes.delete(messageRunId(event));
    },
  };
}

export const messageEventDefinitions = {
  [MESSAGE_RECEIVED]: messageDefinition("interrupt"),
  [PROCESS_MESSAGE]: messageDefinition("after"),
};
