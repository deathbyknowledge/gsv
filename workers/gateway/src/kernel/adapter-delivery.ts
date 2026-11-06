import {
  z,
} from "zod";
import type {
  AdapterActivity,
  AdapterMedia,
  AdapterMediaPart,
  AdapterSendResult,
  BinaryBody,
  MessageAttachment,
  ProcHilRequest,
} from "@humansandmachines/gsv/protocol";
import {
  exceptionDiagnostics,
  type ExceptionDiagnostics,
} from "@humansandmachines/gsv/telemetry";
import {
  bundleAdapterMedia,
  cancelBinaryBody,
  procHilRequestSchema,
} from "@humansandmachines/gsv/protocol";
import {
  type AdapterRunRoute,
} from "./run-routes";
import {
  getConversationById,
} from "../shared/utils";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import {
  agentArchiveMediaPath,
  isValidAgentArchiveMediaObject,
} from "../shared/process-media-path";
import {
  deliverAdapterDestination,
} from "./adapter-send";
import { chatReply, type ChatReply } from "./chat-replies";
import {
  logAdapterBoundaryFailure,
  setAdapterRouteActivity,
} from "./adapter-service";
import type { AdapterMessageTarget } from "./adapter-message-refs";
import type {
  AdapterDeliveryPresentation,
} from "./adapter-send";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import {
  adapterTypingActivity,
  adapterWorkingActivity,
} from "./do-shared";
import type {
  AdapterDeliveryRoute,
} from "./do-shared";
import type { Kernel } from "./do";
import type {
  AdapterRouteDeliveryRetry,
} from "./do-shared";

/** Where a chat send failed: on its route, reading its attachments, or at the messenger. */
export type ChatSendStage = "route" | "media" | "adapter";

/** How a send to a messenger chat went. A retryable failure is safe to send again; an ambiguous one may have arrived. */
export type ChatSend =
  | { state: "sent" }
  | { state: "retryable" | "permanent" | "ambiguous"; error: string; stage: ChatSendStage; diagnostics?: ExceptionDiagnostics };

/** What a messenger chat receives for an event: one message on a process's run route. */
export type ChatDelivery = {
  route: AdapterDeliveryRoute;
  /** The messenger dedupes by it, so a retry never shows the message twice. */
  deliveryId: string;
  text: string;
  /** Committed attachments, read and bundled as the send goes. */
  attachments?: { conversationId: string; authorUid: number; media: MessageAttachment[] };
  /** Answers the message offers, which its messenger shows its own way. */
  choices?: string[];
  hil?: ProcHilRequest;
  /** The canonical message this delivery carries, for a later quote of it to resolve. */
  canonical?: AdapterMessageTarget;
  /** A system notice is the Kernel's, not its process's. */
  presentation: "process" | "system";
  /** Shows typing while it goes. */
  typing: boolean;
};

/** A reply's attachments as its adapter takes them: described one by one, their bytes in one body. */
type ReplyMedia = { media: AdapterMedia[]; body?: BinaryBody };

/** A message, as a retry task queued before replies went through the event log carried it. */
const legacyCommittedSchema = z.object({
  message: z.object({
    id: z.string(), conversationId: z.string(), sequence: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(),
  }),
});


class AdapterReplyMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterReplyMediaError";
  }
}


function mediaTypeFromContentType(contentType: string): AdapterMedia["type"] {
  const normalized = contentType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}


/** The reply a retry task queued before replies went through the event log was carrying. */
function legacyReply(input: AdapterRouteDeliveryRetry): ChatReply | null {
  if (input.event === "message.committed") {
    const message = legacyCommittedSchema.safeParse(input.payload).data?.message;
    return message ? {
      kind: "message", conversationId: message.conversationId, messageId: message.id, sequence: message.sequence, writtenAt: message.createdAt,
    } : null;
  }
  if (input.event === "proc.run.hil.requested") {
    const requestId = procHilRequestSchema.safeParse(input.payload).data?.requestId;
    return requestId ? { kind: "approval", requestId } : null;
  }
  return input.event === "proc.run.finished" ? { kind: "run.failed" } : null;
}


export class AdapterDelivery {
  constructor(readonly host: Kernel) {}

materializePersonalAdapterFallback(
    processId: string,
    runId: string,
    ownerUid: number,
  ): AdapterRunRoute | null {
    const process = this.host.procs.get(processId);
    if (!process?.isPersonalController || process.ownerUid !== ownerUid) {
      return null;
    }
    const preferred = this.host.adapters.privateDestinations.get(ownerUid);
    if (!preferred) {
      return null;
    }
    const ctx = this.host.buildProcessContext(processId, runId);
    if (!ctx) {
      return null;
    }
    try {
      assertAdapterMessageDestinationAccess(preferred.destination, ownerUid, ctx);
    } catch {
      this.host.adapters.privateDestinations.clearIfMatches(ownerUid, preferred.destination);
      return null;
    }
    const link = ctx.adapters.identityLinks.get(
      preferred.destination.adapter,
      preferred.destination.accountId,
      preferred.destination.actorId,
    );
    const routeGeneration = link
      ? identityLinkRouteGeneration(link, preferred.destination.surface)
      : undefined;
    const existing = this.host.runRoutes.get(runId);
    if (existing?.kind === "adapter" && existing.followsShip
      && existing.uid === ownerUid && existing.processId === processId
      && JSON.stringify(existing.destination) === JSON.stringify(preferred.destination)
      && existing.routeGeneration === routeGeneration) return existing;
    return this.host.runRoutes.setAdapterRoute({
      runId,
      followsShip: true,
      processId,
      uid: ownerUid,
      destination: preferred.destination,
      ...(routeGeneration === undefined ? undefined : { routeGeneration }),
    });
  }

/** Logs a run's reply for the chat its route names; the event runner sends it in order with that chat's others. */
  async queueReply(route: AdapterDeliveryRoute, reply: ChatReply): Promise<void> {
    this.host.eventRuntime.append(await chatReply(route, reply));
    await this.host.eventRuntime.kick();
  }

  /**
   * A retry task queued before replies went through the event log hands its reply to the log,
   * which sends it from a fresh first attempt.
   * TODO(event-log): remove the release after the cutover ships, with `legacyReply`,
   * `legacyCommittedSchema`, `AdapterRouteDeliveryRetry` and the task kind in do.ts, plus a
   * migration deleting any `onAdapterRouteDelivery` task rows still left.
   */
  async onAdapterRouteDelivery(input: AdapterRouteDeliveryRetry): Promise<void> {
    const route = input.route ?? this.host.runRoutes.get(input.runId);
    if (!route || route.kind !== "adapter" || route.processId !== input.processId) return;
    const reply = legacyReply(input);
    if (reply) await this.queueReply(route, reply);
  }

  /** Sends one message to its chat; the event runner owns its retries and its end. */
  async sendToChat(delivery: ChatDelivery): Promise<ChatSend> {
    const { route } = delivery;
    let bundle: ReplyMedia = { media: [] };
    if (delivery.attachments) {
      try {
        const { conversationId, media, authorUid } = delivery.attachments;
        bundle = await this.bundleConversationReplyMedia(conversationId, media, authorUid);
      } catch (error) {
        return {
          state: error instanceof AdapterReplyMediaError ? "permanent" : "retryable",
          stage: "media",
          diagnostics: exceptionDiagnostics(error),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (!delivery.text.trim() && bundle.media.length === 0 && !delivery.hil) {
      await this.setRouteActivity(route, adapterWorkingActivity(route, false));
      return { state: "sent" };
    }
    const send = () => this.deliverAdapterRouteReply(route, {
      deliveryId: delivery.deliveryId,
      text: delivery.text,
      ...(bundle.media.length > 0 ? { media: bundle.media } : undefined),
      ...(delivery.choices ? { choices: delivery.choices } : undefined),
      ...(delivery.hil ? { hil: delivery.hil } : undefined),
      ...(delivery.canonical ? { canonical: delivery.canonical } : undefined),
    }, bundle.body, delivery.presentation);
    try {
      return delivery.typing ? await this.deliverWithTyping(route, send) : await send();
    } catch (error) {
      return {
        state: "retryable",
        stage: "adapter",
        diagnostics: exceptionDiagnostics(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

private async setRouteActivity(route: AdapterDeliveryRoute, activity: AdapterActivity | null): Promise<void> {
    await setAdapterRouteActivity(this.host.bindings, this.host.installationId, route, activity).catch(() => undefined);
  }

  /** Typing precedes a delivery; once the reply or approval request is out, Ship's acknowledgement ends. */
  private async deliverWithTyping(
    route: AdapterDeliveryRoute,
    deliver: () => Promise<ChatSend>,
  ): Promise<ChatSend> {
    await this.setRouteActivity(route, adapterTypingActivity(route));
    try {
      return await deliver();
    } finally {
      await this.setRouteActivity(route, adapterWorkingActivity(route, false));
    }
  }

async deliverAdapterRouteReply(
    route: AdapterDeliveryRoute,
    message: {
      deliveryId: string;
      text: string;
      media?: AdapterMedia[];
      choices?: string[];
      replyToId?: string;
      hil?: ProcHilRequest;
      /** The canonical message this delivery carries, for a later quote of it to resolve. */
      canonical?: AdapterMessageTarget;
    },
    body?: BinaryBody,
    presentationKind: "process" | "system" = "process",
  ): Promise<ChatSend> {
    const ctx = this.host.buildProcessContext(route.processId, route.runId);
    if (!ctx) {
      await cancelBinaryBody(body, "Reply route references a missing process");
      return { state: "permanent", stage: "route", error: "Reply route references a missing process" };
    }
    try {
      assertAdapterMessageDestinationAccess(route.destination, route.uid, ctx);
    } catch (error) {
      await cancelBinaryBody(body, error);
      ctx.adapters.privateDestinations.clearIfMatches(route.uid, route.destination);
      return {
        state: "permanent",
        stage: "route",
        diagnostics: exceptionDiagnostics(error),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const process = this.host.procs.get(route.processId);
    const presentation: AdapterDeliveryPresentation = {
      processId: route.processId,
      runId: route.runId,
    };
    if (presentationKind === "process" && process?.isPersonalController === false) {
      presentation.processMode = "work";
    } else if (presentationKind === "process" && process?.isPersonalController === true) {
      presentation.processMode = "ship";
      if (route.destination.surface.kind === "dm") {
        const selected = this.host.adapters.surfaceRoutes.resolveRoute({
          adapter: route.destination.adapter,
          accountId: route.destination.accountId,
          actorId: route.destination.actorId,
          surfaceKind: route.destination.surface.kind,
          surfaceId: route.destination.surface.id,
          threadId: route.destination.surface.threadId,
          uid: route.uid,
        });
        if (selected?.mode === "work") presentation.shipDisplaced = true;
      }
    }
    if (message.hil) presentation.hil = message.hil;

    const result = await deliverAdapterDestination(route.destination, route.uid, {
      deliveryId: message.deliveryId,
      text: message.text,
      ...(message.media === undefined ? undefined : { media: message.media }),
      ...(message.choices === undefined ? undefined : { choices: message.choices }),
      replyToId: message.replyToId ?? route.replyToId,
      ...(route.routeGeneration === undefined
        ? undefined
        : { routeGeneration: route.routeGeneration }),
    }, ctx, body, presentation);
    if (!result.ok) {
      return {
        state: result.retryable ? "retryable" : "permanent",
        stage: "adapter",
        diagnostics: result.diagnostics,
        error: `Adapter reply failed (${route.destination.adapter}): ${result.error}`,
      };
    }
    if (result.deliveryState === "ambiguous") {
      return {
        state: "ambiguous",
        stage: "adapter",
        diagnostics: result.diagnostics,
        error: `Adapter delivery ${message.deliveryId} is ambiguous`,
      };
    }
    if (message.canonical) this.recordMessageRefs(route, message.canonical, result);
    return { state: "sent" };
  }

  /** The message is out by now, so a failure here costs a later quote and never a retry. */
  private recordMessageRefs(
    route: AdapterDeliveryRoute,
    canonical: AdapterMessageTarget,
    result: Extract<AdapterSendResult, { ok: true }>,
  ): void {
    const providerMessageIds = result.messageIds ?? (result.messageId ? [result.messageId] : []);
    try {
      this.host.adapters.messageRefs.record({
        ownerUid: route.uid,
        adapter: route.destination.adapter,
        accountId: route.destination.accountId,
        surface: route.destination.surface,
      }, canonical, providerMessageIds);
    } catch {
      logAdapterBoundaryFailure("error", "message_ref_write_failed");
    }
  }

async bundleConversationReplyMedia(
    conversationId: string,
    value: MessageAttachment[] | undefined,
    authorUid: number,
  ): Promise<ReplyMedia> {
    if (value === undefined) {
      return { media: [] };
    }
    if (value.length > MAX_MESSAGE_MEDIA_ITEMS) {
      throw new AdapterReplyMediaError(
        `Process reply media exceeds item limit (${MAX_MESSAGE_MEDIA_ITEMS})`,
      );
    }
    const conversation = getConversationById(this.host.installationId, conversationId);
    const parts: AdapterMediaPart[] = [];
    let totalBytes = 0;
    try {
      for (const item of value) {
        if (item.type === "resource") {
          const { ref } = item;
          const account = this.host.auth.getPasswdByUid(authorUid);
          const key = ref.path.replace(/^\/+/, "");
          const object = ref.target === "gsv" && ref.expiresAt === undefined
            ? await this.host.installationStorage.get(key)
            : null;
          const matches = account
            && object
            && agentArchiveMediaPath(account.home, key) === ref.path
            && object.httpEtag === ref.revision
            && object.size === ref.size
            && isValidAgentArchiveMediaObject({
              home: account.home,
              key,
              uid: account.uid,
              gid: account.gid,
              object,
              expectedContentType: ref.contentType,
            });
          if (!matches || !object) {
            await object?.body.cancel("Message resource descriptor mismatch").catch(() => {});
            throw new AdapterReplyMediaError("Message resource does not match retained data");
          }
          if (ref.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
            await object.body.cancel("Message resource exceeds the per-item limit").catch(() => {});
            throw new AdapterReplyMediaError(
              `Message media exceeds per-item limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes)`,
            );
          }
          totalBytes += ref.size;
          if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
            await object.body.cancel("Message resources exceed the total limit").catch(() => {});
            throw new AdapterReplyMediaError(
              `Message media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
            );
          }
          const media: AdapterMedia = {
            type: item.mediaType ?? mediaTypeFromContentType(ref.contentType),
            mimeType: ref.contentType,
            size: ref.size,
          };
          if (item.filename) media.filename = item.filename;
          if (item.duration !== undefined) media.duration = item.duration;
          if (item.transcription) media.transcription = item.transcription;
          parts.push({ media, body: { stream: object.body, length: object.size } });
          continue;
        }
        const key = item.key?.trim() ?? "";
        if (!key || item.conversationId !== conversationId) {
          throw new AdapterReplyMediaError("Message media is outside its conversation");
        }
        const mimeType = item.mimeType.trim();
        if (!mimeType) {
          throw new AdapterReplyMediaError("Process reply media requires mimeType");
        }
        const object = await conversation.readMedia({ key });
        if (object.size > MAX_MESSAGE_MEDIA_PART_BYTES) {
          await object.stream.cancel("Conversation media exceeds the per-item limit").catch(() => {});
          throw new AdapterReplyMediaError(
            `Message media exceeds per-item limit (${MAX_MESSAGE_MEDIA_PART_BYTES} bytes)`,
          );
        }
        totalBytes += object.size;
        if (totalBytes > MAX_MESSAGE_MEDIA_TOTAL_BYTES) {
          await object.stream.cancel("Conversation media exceeds the total limit").catch(() => {});
          throw new AdapterReplyMediaError(
            `Message media exceeds total limit (${MAX_MESSAGE_MEDIA_TOTAL_BYTES} bytes)`,
          );
        }
        if (object.mimeType !== mimeType || item.size !== object.size) {
          await object.stream.cancel("Conversation media descriptor mismatch").catch(() => {});
          throw new AdapterReplyMediaError(
            `Message media descriptor does not match stored data: ${key}`,
          );
        }
        const media: AdapterMedia = {
            type: item.type,
            mimeType,
            size: object.size,
        };
        if (item.filename) media.filename = item.filename;
        if (item.duration !== undefined && Number.isFinite(item.duration)) {
          media.duration = item.duration;
        }
        if (item.transcription) media.transcription = item.transcription;
        parts.push({
          media,
          body: { stream: object.stream, length: object.size },
        });
      }
      return await bundleAdapterMedia(parts);
    } catch (error) {
      await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
      throw error;
    }
  }
}
