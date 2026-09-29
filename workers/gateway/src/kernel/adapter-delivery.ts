import {
  z,
} from "zod";
import type {
  SignalFrame,
} from "../protocol/frames";
import type {
  AdapterMedia,
  AdapterMediaPart,
  BinaryBody,
  MessageAttachment,
  ProcHilRequest,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import {
  bundleAdapterMedia,
  cancelBinaryBody,
  procHilRequestSchema,
  resourceBlockSchema,
} from "@humansandmachines/gsv/protocol";
import {
  type AdapterRunRoute,
} from "./run-routes";
import {
  getConversationById,
  sendFrameToProcess,
} from "../shared/utils";
import {
  stableOpaqueId,
} from "../shared/stable-id";
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
import {
  setAdapterActivityForKernel,
} from "./adapter-service";
import type {
  AdapterDeliveryPresentation,
} from "./adapter-send";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import {
  procMediaInputSchema,
  adapterTypingActivity,
} from "./do-shared";
import type {
  AdapterDeliveryRoute,
} from "./do-shared";
import type { Kernel } from "./do";
import type {
  AdapterRouteDeliveryRetry,
  ProcessDeliveryNoticeRetry,
} from "./do-shared";

const MAX_ADAPTER_ROUTE_DELIVERY_ATTEMPTS = 10;


type AdapterRouteDeliveryOutcome =
  | { state: "delivered" }
  | { state: "skipped" }
  | { state: "retryable" | "permanent" | "ambiguous"; error: string };


type ProcessDeliveryNoticePayload = Omit<
  ProcessDeliveryNoticeRetry,
  "processId" | "deliveryId" | "route" | "cleanupRunRoute"
>;


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


function adapterRouteRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}


const adapterConversationMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sequence: z.number().int().nonnegative(),
  author: z.object({
    kind: z.literal("process"),
    pid: z.string(),
    uid: z.number().int().nonnegative(),
  }),
  text: z.string(),
  media: z.array(z.union([resourceBlockSchema, procMediaInputSchema])).optional(),
  origin: z.object({
    kind: z.literal("process"),
    pid: z.string(),
    runId: z.string(),
  }),
  processId: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.number(),
});


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
    return this.host.runRoutes.setAdapterRoute({
      runId,
      processId,
      uid: ownerUid,
      destination: preferred.destination,
      ...(routeGeneration === undefined ? undefined : { routeGeneration }),
    });
  }

async attemptAdapterRouteDelivery(
    route: AdapterDeliveryRoute,
    frame: SignalFrame,
    attempt: number,
  ): Promise<void> {
    let outcome: AdapterRouteDeliveryOutcome;
    try {
      const parsedHilRequest = frame.signal === "proc.run.hil.requested"
        ? procHilRequestSchema.safeParse(frame.payload)
        : null;
      const hilRequestId = parsedHilRequest?.success
        ? parsedHilRequest.data.requestId
        : undefined;
      if (
        hilRequestId
        && !await this.isAdapterHilRequestPending(
          route.processId,
          route.runId,
          hilRequestId,
        )
      ) {
        outcome = { state: "skipped" };
      } else {
        outcome = await this.deliverAdapterRouteEvent(route, frame);
      }
    } catch (error) {
      outcome = {
        state: error instanceof AdapterReplyMediaError ? "permanent" : "retryable",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.state === "retryable" && attempt < MAX_ADAPTER_ROUTE_DELIVERY_ATTEMPTS) {
      await this.queueAdapterRouteDelivery(route, frame, attempt + 1);
      return;
    }

    if (outcome.state === "delivered" || outcome.state === "skipped") return;

    const terminalState = outcome.state === "retryable" ? "exhausted" : outcome.state;
    const deliveryError = outcome.error;
    const approval = frame.signal === "proc.run.hil.requested";
    const label = approval ? "approval notification" : "message";
    await this.queueProcessDeliveryNotice(route, frame, {
      state: terminalState,
      message: terminalState === "ambiguous"
        ? `The ${label} reached the adapter, but provider delivery is ambiguous. It was not retried to avoid a duplicate.`
        : terminalState === "permanent"
          ? `The ${label} could not be delivered: ${deliveryError}`
          : `The ${label} stopped after ${attempt} retry-safe delivery attempts: ${deliveryError}`,
    });
    emitTelemetry(this.host.bindings, {
      installationId: this.host.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.route_delivery.failed",
        properties: {
          adapter: route.destination.adapter.trim().toLowerCase(),
          deliveryKind: approval ? "approval" : "message",
          surface: route.destination.surface.kind,
          outcome: "failed",
          failureKind: terminalState,
          attempts: attempt,
        },
      },
    });
  }

async queueAdapterRouteDelivery(
    route: AdapterDeliveryRoute,
    frame: SignalFrame,
    attempt: number,
  ): Promise<void> {
    const payload = frame.payload === undefined ? undefined : z.json().parse(frame.payload);
    const retry: AdapterRouteDeliveryRetry = {
      runId: route.runId,
      processId: route.processId,
      route,
      event: frame.signal,
      attempt,
    };
    if (payload !== undefined) retry.payload = payload;
    await this.host.schedule(
      new Date(Date.now() + (attempt === 1 ? 10 : adapterRouteRetryDelayMs(attempt - 1))),
      "onAdapterRouteDelivery",
      retry,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

async onAdapterRouteDelivery(input: AdapterRouteDeliveryRetry): Promise<void> {
    const route = input.route ?? this.host.runRoutes.get(input.runId);
    if (!route || route.kind !== "adapter" || route.processId !== input.processId) {
      return;
    }
    await this.attemptAdapterRouteDelivery(route, {
      type: "sig",
      signal: input.event,
      payload: input.payload,
    }, input.attempt);
  }

async isAdapterHilRequestPending(
    processId: string,
    runId: string,
    requestId: string,
  ): Promise<boolean> {
    const response = await sendFrameToProcess(this.host.installationId, processId, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.history",
      args: { pid: processId, limit: 1, offset: 0 },
    });
    if (!response || response.type !== "res" || !response.ok) {
      throw new Error(`Unable to verify pending approval ${requestId}`);
    }
    const data = response.data;
    if (!data?.ok) {
      throw new Error(`Unable to verify pending approval ${requestId}`);
    }
    const pending = data.pendingHil;
    return pending?.requestId === requestId && pending.runId === runId;
  }

async queueProcessDeliveryNotice(
    route: AdapterDeliveryRoute,
    frame: SignalFrame,
    outcome: { state: "permanent" | "ambiguous" | "exhausted"; message: string },
  ): Promise<void> {
    const deliveryKind = frame.signal === "proc.run.hil.requested" ? "hil" : "message";
    const parsedHilRequest = deliveryKind === "hil"
      ? procHilRequestSchema.safeParse(frame.payload)
      : null;
    const requestId = parsedHilRequest?.success
      ? parsedHilRequest.data.requestId
      : undefined;
    if (deliveryKind === "hil" && !requestId) {
      return;
    }
    const parsedMessage = deliveryKind === "message"
      ? z.object({ message: z.object({ id: z.string().min(1) }) }).safeParse(frame.payload)
      : null;
    const deliveryId = parsedMessage?.success ? parsedMessage.data.message.id : undefined;
    await this.queueProcessDeliveryNoticeRecord(route, {
      deliveryKind,
      deliveryId,
      requestId,
      ...outcome,
    });
  }

async queueProcessDeliveryNoticeRecord(
    route: AdapterDeliveryRoute,
    input: {
      deliveryKind: "hil" | "message";
      deliveryId?: string;
      requestId?: string;
      state: "permanent" | "ambiguous" | "exhausted";
      message: string;
    },
  ): Promise<void> {
    const { deliveryKind, requestId } = input;
    const noticeId = await stableOpaqueId("process-delivery-notice", [
      route.runId,
      deliveryKind,
      input.deliveryId ?? requestId ?? "",
      input.state,
    ]);
    const notice: ProcessDeliveryNoticeRetry = {
      noticeId,
      runId: route.runId,
      processId: route.processId,
      deliveryKind,
      route,
      state: input.state,
      message: input.message,
    };
    if (input.deliveryId) notice.deliveryId = input.deliveryId;
    if (requestId) notice.requestId = requestId;
    await this.host.schedule(
      new Date(Date.now() + 10),
      "onProcessDeliveryNotice",
      notice,
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  }

async onProcessDeliveryNotice(input: ProcessDeliveryNoticeRetry): Promise<void> {
    const route = input.route ?? this.host.runRoutes.get(input.runId);
    if (!route || route.kind !== "adapter" || route.processId !== input.processId) {
      return;
    }
    const requestId = input.requestId;
    if (input.deliveryKind === "hil") {
      if (!requestId || !await this.isAdapterHilRequestPending(
        input.processId,
        input.runId,
        requestId,
      )) {
        return;
      }
    }
    const payload: ProcessDeliveryNoticePayload = {
      noticeId: input.noticeId,
      runId: input.runId,
      deliveryKind: input.deliveryKind,
      state: input.state,
      message: input.message,
    };
    if (requestId) payload.requestId = requestId;
    await sendFrameToProcess(this.host.installationId, input.processId, {
      type: "sig",
      signal: "proc.delivery.notice",
      payload,
    });
  }

async deliverAdapterRouteEvent(
    route: AdapterDeliveryRoute,
    frame: SignalFrame,
  ): Promise<AdapterRouteDeliveryOutcome> {
    const { adapter, accountId, surface } = route.destination;
    if (frame.signal === "proc.run.started") {
      await setAdapterActivityForKernel(
        this.host.bindings,
        this.host.installationId,
        adapter,
        accountId,
        surface,
        adapterTypingActivity(route, true),
      );
      return { state: "delivered" };
    }

    if (frame.signal === "proc.run.hil.requested") {
      const parsedRequest = procHilRequestSchema.safeParse(frame.payload);
      if (!parsedRequest.success) {
        await setAdapterActivityForKernel(
          this.host.bindings,
          this.host.installationId,
          adapter,
          accountId,
          surface,
          adapterTypingActivity(route, false),
        ).catch(() => undefined);
        return { state: "skipped" };
      }
      const request = parsedRequest.data;

      try {
        return await this.deliverAdapterRouteReply(route, {
          deliveryId: `${route.runId}:hil:${request.requestId}`,
          text: "",
          hil: request,
        });
      } finally {
        await setAdapterActivityForKernel(
          this.host.bindings,
          this.host.installationId,
          adapter,
          accountId,
          surface,
          adapterTypingActivity(route, false),
        ).catch((error) => {
          console.warn(`[Kernel] Failed to stop adapter typing for ${route.runId}:`, error);
        });
      }
    }

    if (frame.signal === "message.committed") {
      const parsed = z.object({ message: adapterConversationMessageSchema }).safeParse(frame.payload);
      if (!parsed.success) return { state: "skipped" };
      const message = parsed.data.message;
      if (message.processId !== route.processId || message.runId !== route.runId) {
        return { state: "skipped" };
      }
      try {
        const attachmentBundle = await this.bundleConversationReplyMedia(
          message.conversationId,
          message.media,
          message.author.uid,
        );
        if (!message.text.trim() && attachmentBundle.media.length === 0) {
          return { state: "delivered" };
        }
        const reply = {
          deliveryId: message.id,
          text: message.text,
          media: attachmentBundle.media.length > 0 ? attachmentBundle.media : undefined,
        };
        return await this.deliverAdapterRouteReply(route, reply, attachmentBundle.body);
      } finally {
        await setAdapterActivityForKernel(
          this.host.bindings,
          this.host.installationId,
          adapter,
          accountId,
          surface,
          adapterTypingActivity(route, false),
        ).catch(() => undefined);
      }
    }

    return { state: "skipped" };
  }

async deliverAdapterRouteReply(
    route: AdapterDeliveryRoute,
    message: {
      deliveryId: string;
      text: string;
      media?: AdapterMedia[];
      replyToId?: string;
      hil?: ProcHilRequest;
    },
    body?: BinaryBody,
  ): Promise<AdapterRouteDeliveryOutcome> {
    const ctx = this.host.buildProcessContext(route.processId, route.runId);
    if (!ctx) {
      await cancelBinaryBody(body, "Reply route references a missing process");
      return { state: "permanent", error: "Reply route references a missing process" };
    }
    try {
      assertAdapterMessageDestinationAccess(route.destination, route.uid, ctx);
    } catch (error) {
      await cancelBinaryBody(body, error);
      ctx.adapters.privateDestinations.clearIfMatches(route.uid, route.destination);
      return {
        state: "permanent",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const process = this.host.procs.get(route.processId);
    const presentation: AdapterDeliveryPresentation = {
      processId: route.processId,
      runId: route.runId,
    };
    if (process?.isPersonalController === false) {
      presentation.processMode = "work";
    } else if (process?.isPersonalController === true) {
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
      replyToId: message.replyToId ?? route.replyToId,
      ...(route.routeGeneration === undefined
        ? undefined
        : { routeGeneration: route.routeGeneration }),
    }, ctx, body, presentation);
    if (!result.ok) {
      return {
        state: result.retryable ? "retryable" : "permanent",
        error: `Adapter reply failed (${route.destination.adapter}): ${result.error}`,
      };
    }
    if (result.deliveryState === "ambiguous") {
      return {
        state: "ambiguous",
        error: `Adapter delivery ${message.deliveryId} is ambiguous`,
      };
    }
    return { state: "delivered" };
  }

async bundleConversationReplyMedia(
    conversationId: string,
    value: MessageAttachment[] | undefined,
    authorUid: number,
  ): Promise<{ media: AdapterMedia[]; body?: BinaryBody }> {
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
