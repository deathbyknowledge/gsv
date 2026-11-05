import { z } from "zod";
import type { ConversationMessage, ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { emitTelemetry, exceptionDiagnostics, sanitizeExceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { stableOpaqueId } from "../shared/stable-id";
import { getConversationById, sendFrameToProcess } from "../shared/utils";
import type { ChatDelivery } from "./adapter-delivery";
import { deliveryFailed } from "./delivery-events";
import { adapterDeliveryRouteSchema, type AdapterDeliveryRoute } from "./do-shared";
import { chatConsumer, deliveryId } from "./events/consumers";
import type { ChatUnsent, EventDefinition } from "./events/registry";
import type { EventInput } from "./events/store";

/** A run's reply, approval request or failure notice, for the messenger chat its route names. */
export const CHAT_REPLY = "chat.reply";

/** The one lane a chat orders everything for it on. */
const CHAT_LANE = "messages";

/**
 * A message that didn't reach its chat wakes the process that wrote it, which can find another
 * way to the person, until this many in a row have failed there. After that each one is only
 * noted, so a chat that keeps failing can't keep its process busy.
 */
const FAILED_MESSAGES_THAT_WAKE = 3;

/** What a chat shows when the run that should answer there failed. */
const RUN_FAILURE_NOTICE = "System notice: Ship couldn’t finish this request. Open Chat for details, or send another message to try again.";

const replySchema = z.discriminatedUnion("kind", [
  // A committed message, read from its Conversation when it goes: chat text has no size limit.
  z.strictObject({
    kind: z.literal("message"),
    conversationId: z.string(),
    messageId: z.string(),
    sequence: z.number().int().nonnegative(),
  }),
  // An approval request, read from its process, which goes only while that request is pending.
  z.strictObject({ kind: z.literal("approval"), requestId: z.string() }),
  // The run failed without answering the message that started it.
  z.strictObject({ kind: z.literal("run.failed") }),
]);

const bodySchema = z.strictObject({
  /** The chat's opaque id, which names its consumer. */
  chat: z.string(),
  route: adapterDeliveryRouteSchema,
  reply: replySchema,
});

export type ChatReply = z.infer<typeof replySchema>;

type Prepared =
  | { kind: "message"; message: ConversationMessage; authorUid: number }
  | { kind: "approval"; request: ProcHilRequest }
  | { kind: "run.failed"; deliveryId: string };

function replyBody(event: Pick<EventInput, "body">) {
  return bodySchema.parse(event.body);
}

/**
 * A reply for the chat a run's route names, keyed by what it carries, so a repeated commit or
 * signal appends nothing. Everything for one chat goes out in order, whichever process wrote it.
 */
export async function chatReply(route: AdapterDeliveryRoute, reply: ChatReply): Promise<EventInput> {
  const { destination } = route;
  const { surface } = destination;
  // Opaque, so no provider's id names a consumer.
  const chat = await stableOpaqueId("chat", [
    String(route.uid), destination.adapter, destination.accountId, surface.kind, surface.id, surface.threadId ?? "",
  ]);
  return {
    type: CHAT_REPLY,
    ownerUid: route.uid,
    subject: `proc:${route.processId}`,
    actor: reply.kind === "run.failed" ? { kind: "kernel" } : { kind: "process", pid: route.processId },
    key: reply.kind === "message" ? `message:${reply.messageId}`
      : reply.kind === "approval" ? `approval:${route.runId}:${reply.requestId}`
        : `run.failed:${route.processId}:${route.runId}`,
    body: {
      chat,
      route: {
        kind: "adapter",
        runId: route.runId,
        processId: route.processId,
        uid: route.uid,
        destination: {
          kind: "adapter",
          adapter: destination.adapter,
          accountId: destination.accountId,
          actorId: destination.actorId,
          surface: {
            kind: surface.kind,
            id: surface.id,
            ...(surface.name === undefined ? undefined : { name: surface.name }),
            ...(surface.handle === undefined ? undefined : { handle: surface.handle }),
            ...(surface.threadId === undefined ? undefined : { threadId: surface.threadId }),
          },
        },
        ...(route.replyToId === undefined ? undefined : { replyToId: route.replyToId }),
        ...(route.routeGeneration === undefined ? undefined : { routeGeneration: route.routeGeneration }),
      },
      reply,
    },
  };
}

/** The approval its process waits on, if any; throws when the process can't say. */
async function pendingApproval(installationId: string, pid: string): Promise<ProcHilRequest | null> {
  const response = await sendFrameToProcess(installationId, pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.history",
    args: { pid, limit: 1, offset: 0 },
  });
  if (!response || response.type !== "res" || !response.ok || !response.data?.ok) {
    throw new Error("Unable to read the process's pending approval");
  }
  return response.data.pendingHil ?? null;
}

/** What the process reads about a reply that never reached its chat. */
function failureMessage(reply: ChatReply, unsent: ChatUnsent, error: string): string {
  const label = reply.kind === "approval" ? "approval notification"
    : reply.kind === "run.failed" ? "run failure notice" : "message";
  if (unsent.outcome === "ambiguous") {
    return `The ${label} reached the adapter, but provider delivery is ambiguous. It was not retried to avoid a duplicate.`;
  }
  if (unsent.outcome === "permanent") return `The ${label} could not be delivered: ${error}`;
  return `The ${label} stopped after ${unsent.attempts} retry-safe delivery attempts: ${error}`;
}

export const chatReplyEvent: EventDefinition<Prepared> = {
  routes: (event) => [{ consumer: chatConsumer(replyBody(event).chat), lane: CHAT_LANE }],
  // A reply answers for its process's run; once that process is gone there is no run to answer for.
  withdrawal: (event, ctx) => ctx.procs.get(replyBody(event).route.processId) ? null : "the process is gone",
  async prepare(event, ctx) {
    const { route, reply } = replyBody(event);
    if (reply.kind === "message") {
      const message = await getConversationById(ctx.installationId, reply.conversationId)
        .readMessage({ sequence: reply.sequence, messageId: reply.messageId });
      if (!message) return { withdrawn: "the message is no longer in its conversation" };
      // A route answers for one run, so it carries only that run's messages.
      if (message.author.kind !== "process" || message.processId !== route.processId || message.runId !== route.runId) {
        return { withdrawn: "the message is not its run's" };
      }
      return { kind: "message", message, authorUid: message.author.uid };
    }
    if (reply.kind === "approval") {
      const request = await pendingApproval(ctx.installationId, route.processId);
      return request?.requestId === reply.requestId && request.runId === route.runId
        ? { kind: "approval", request }
        : { withdrawn: "the approval is no longer pending" };
    }
    return { kind: "run.failed", deliveryId: await stableOpaqueId("process-run-failure", [route.processId, route.runId]) };
  },
  present(event, prepared): ChatDelivery {
    const { route } = replyBody(event);
    if (prepared.kind === "message") {
      const { message } = prepared;
      return {
        route,
        deliveryId: message.id,
        text: message.text,
        ...(message.media?.length
          ? { attachments: { conversationId: message.conversationId, authorUid: prepared.authorUid, media: message.media } }
          : undefined),
        ...(message.choices?.length ? { choices: message.choices } : undefined),
        canonical: { conversationId: message.conversationId, messageId: message.id, sequence: message.sequence },
        presentation: "process",
        typing: true,
      };
    }
    if (prepared.kind === "approval") {
      return {
        route,
        deliveryId: `${route.runId}:hil:${prepared.request.requestId}`,
        text: "",
        hil: prepared.request,
        presentation: "process",
        typing: true,
      };
    }
    return { route, deliveryId: prepared.deliveryId, text: RUN_FAILURE_NOTICE, presentation: "system", typing: false };
  },
  // A reply that ends unsent tells the process that wrote it, and a failed message wakes it.
  async settled(event, ctx, end) {
    if (end.state !== "failed" || end.unsent === undefined) return;
    const { chat, route, reply } = replyBody(event);
    const consumer = chatConsumer(chat);
    // The process may be gone by now, leaving no one to tell.
    if (ctx.procs.get(route.processId)) {
      const wake = reply.kind === "message"
        && ctx.events.failedInARow(consumer, FAILED_MESSAGES_THAT_WAKE + 1) <= FAILED_MESSAGES_THAT_WAKE;
      // Appended before this hook's first await, so the ended delivery and its failure commit together.
      ctx.events.append(deliveryFailed({
        ownerUid: event.ownerUid,
        pid: route.processId,
        runId: route.runId,
        noticeId: deliveryId(event.id, consumer),
        ...(reply.kind === "approval" ? { requestId: reply.requestId } : undefined),
        message: failureMessage(reply, end.unsent, end.reason),
        wake,
      }));
    }
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.route_delivery.failed",
        properties: {
          adapter: route.destination.adapter.trim().toLowerCase(),
          deliveryKind: reply.kind === "approval" ? "approval" : "message",
          surface: route.destination.surface.kind,
          outcome: "failed",
          failureKind: end.unsent.outcome,
          attempts: end.unsent.attempts,
          stage: end.unsent.stage,
          ...sanitizeExceptionDiagnostics(end.unsent.diagnostics ?? exceptionDiagnostics(end.reason)),
        },
      },
    });
    await ctx.events.kick();
  },
};
