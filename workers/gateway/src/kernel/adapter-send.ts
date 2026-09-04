import type {
  AdapterMedia,
  AdapterDeliveryContext,
  AdapterSurface,
} from "../adapter-interface";
import type {
  AdapterMessageDestination,
  AdapterSendArgs,
  AdapterSendResult,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";
import {
  binaryBodySchema,
  cancelBinaryBody,
  adapterSendResultSchema,
  validateAdapterMediaBody,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import * as z from "zod/mini";
import {
  resolveCallerOwnerUid,
  type KernelContext,
} from "./context";
import type {
  RequestFrame,
} from "../protocol/frames";
import type {
  IdentityLinkRecord,
} from "./identity-links";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkAllowsSurface,
  identityLinkRouteGeneration,
  normalizeAdapterMessageDestination,
  normalizeAdapterSurface,
} from "./adapter-destinations";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import {
  logAdapterBoundaryFailure,
  resolveAdapterService,
} from "./adapter-service";

/** Outbound adapter delivery: adapter.send and Kernel-initiated destination delivery. */
const adapterFrameBodySchema = z.object({ body: binaryBodySchema });

export type AdapterDeliveryPresentation = {
  processId: string;
  runId: string;
  processMode?: AdapterDeliveryContext["processMode"];
  shipDisplaced?: boolean;
  hil?: AdapterDeliveryContext["hil"];
};

const adapterSurfaceKindSchema = z.enum(["dm", "group", "channel", "thread"]);

const optionalStringSchema = z.optional(z.string());

const optionalBooleanSchema = z.optional(z.boolean());

function adapterSendBoundaryError(args: AdapterSendArgs): string | null {
  if (!adapterSurfaceKindSchema.safeParse(args.surface?.kind).success) {
    return "surface.kind is invalid";
  }
  if (!z.string().check(z.minLength(1)).safeParse(args.surface?.id).success) {
    return "surface.id is required";
  }
  if (!z.string().safeParse(args.text).success) {
    return "text must be a string";
  }
  if (!optionalStringSchema.safeParse(args.replyToId).success) {
    return "replyToId must be a string";
  }
  if (!optionalBooleanSchema.safeParse(args.also).success) {
    return "also must be a boolean";
  }
  if (!optionalStringSchema.safeParse(args.deliveryId).success) {
    return "Adapter deliveryId is invalid";
  }
  return null;
}

export async function handleAdapterSend(
  args: AdapterSendArgs,
  ctx: KernelContext,
  body?: BinaryBody,
): Promise<AdapterSendResult> {
  const boundaryError = adapterSendBoundaryError(args);
  if (boundaryError) return rejectAdapterSend(body, boundaryError);

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  if (!adapter) return rejectAdapterSend(body, "adapter is required");
  if (!accountId) return rejectAdapterSend(body, "accountId is required");
  let surface: AdapterSurface;
  try {
    surface = normalizeAdapterSurface(args.surface);
  } catch (error) {
    return rejectAdapterSend(
      body,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!args.also && isCurrentAutomaticReplyDestination(ctx, adapter, accountId, surface)) {
    return rejectAdapterSend(
      body,
      "This target is the current run's directed endpoint. Finish with Message, or use --also to intentionally send a separate message.",
    );
  }
  if (!canSendToAdapterSurface(ctx, adapter, accountId, surface)) {
    return rejectAdapterSend(body, "Permission denied");
  }

  return deliverAdapterMessage({
    ...args,
    adapter,
    accountId,
    surface,
    replyToId: args.replyToId?.trim() || undefined,
  }, ctx, body);
}

/**
 * Deliver to a trusted, Kernel-resolved adapter destination. This deliberately
 * bypasses the explicit-send duplicate guard while still rechecking that the
 * linked actor belongs to the destination owner.
 */
export async function deliverAdapterDestination(
  destination: AdapterMessageDestination,
  ownerUid: number,
  message: Pick<AdapterSendArgs, "deliveryId" | "text" | "media" | "replyToId"> & {
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  let normalized: AdapterMessageDestination;
  try {
    normalized = normalizeAdapterMessageDestination(destination);
    assertAdapterMessageDestinationAccess(normalized, ownerUid, ctx);
  } catch (error) {
    await cancelBinaryBody(body, error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return deliverAdapterMessage({
    adapter: normalized.adapter,
    accountId: normalized.accountId,
    actorId: normalized.actorId,
    surface: normalized.surface,
    ...message,
  }, ctx, body, presentation);
}

async function deliverAdapterMessage(
  args: Pick<AdapterSendArgs, "adapter" | "accountId" | "deliveryId" | "surface" | "text" | "media" | "replyToId"> & {
    actorId?: string;
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  const startedAt = Date.now();
  try {
    const result = await deliverAdapterMessageOwned(args, ctx, body, presentation);
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.delivery.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: result.ok
            ? result.deliveryState ?? "sent"
            : result.retryable
              ? "retryable_error"
              : "rejected",
          hasMedia: Boolean(args.media?.length),
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    return result;
  } catch (error) {
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.delivery.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: "error",
          hasMedia: Boolean(args.media?.length),
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    throw error;
  }
}

async function deliverAdapterMessageOwned(
  args: Pick<AdapterSendArgs, "adapter" | "accountId" | "deliveryId" | "surface" | "text" | "media" | "replyToId"> & {
    actorId?: string;
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  let routeGeneration = args.routeGeneration;
  if (args.actorId) {
    const link = ctx.adapters.identityLinks.get(adapter, accountId, args.actorId);
    const currentGeneration = link
      ? identityLinkRouteGeneration(link, args.surface)
      : undefined;
    if (routeGeneration !== undefined && routeGeneration !== currentGeneration) {
      await cancelBinaryBody(body, "Adapter route changed before delivery");
      return {
        ok: false,
        error: "Adapter route changed before delivery",
        retryable: false,
      };
    }
    routeGeneration ??= currentGeneration;
  }

  const deliveryId = args.deliveryId?.trim() || crypto.randomUUID();
  if (deliveryId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(deliveryId)) {
    await cancelBinaryBody(body, "Invalid adapter delivery id");
    return { ok: false, error: "Adapter deliveryId is invalid", retryable: false };
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service?.adapterFrame) {
    await cancelBinaryBody(body, `Adapter service unavailable: ${adapter}`);
    return {
      ok: false,
      error: `Adapter service unavailable: ${adapter}`,
      deliveryId,
      retryable: true,
    };
  }

  try {
    validateAdapterMediaBody(args.media, body, {
      maxBytes: MAX_MESSAGE_MEDIA_TOTAL_BYTES,
      maxPartBytes: MAX_MESSAGE_MEDIA_PART_BYTES,
    });
    validateAdapterMediaItems(args.media, "outbound");
    ctx.requestSignal?.throwIfAborted();
  } catch (error) {
    await cancelBinaryBody(body, error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deliveryId,
      retryable: false,
    };
  }

  const context: AdapterDeliveryContext = {
    deliveryId,
    accountId,
    surface: args.surface,
    ...presentation,
  };
  if (args.actorId) context.actorId = args.actorId;
  if (routeGeneration !== undefined) context.routeGeneration = routeGeneration;
  const request: RequestFrame<"adapter.send"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "adapter.send",
    args: {
      adapter,
      accountId,
      deliveryId,
      surface: args.surface,
      text: args.text,
      ...(args.replyToId === undefined ? undefined : { replyToId: args.replyToId }),
      ...(args.media === undefined ? undefined : { media: args.media }),
    },
    ...(body === undefined ? undefined : { body }),
  };
  let responseBody: BinaryBody | undefined;
  try {
    const response = await service.adapterFrame(
      { installationId: ctx.installationId },
      context,
      request,
    );
    const parsedBody = adapterFrameBodySchema.safeParse(response);
    if (parsedBody.success) responseBody = parsedBody.data.body;
    if (!response || response.type !== "res" || response.id !== request.id) {
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, true),
        deliveryId,
        retryable: true,
      };
    }
    if (!response.ok) {
      const retryable = response.error?.retryable === true;
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, retryable),
        deliveryId,
        retryable,
      };
    }
    const decoded = adapterSendResultSchema.safeParse(response.data);
    if (!decoded.success) {
      logAdapterBoundaryFailure("error", "send_frame_invalid_response");
      return {
        ok: false,
        error: `Adapter returned an invalid adapter.send response: ${adapter}`,
        deliveryId,
        retryable: false,
      };
    }
    const result = decoded.data;
    if (!result.ok) {
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, result.retryable === true),
        deliveryId,
        retryable: result.retryable === true,
      };
    }
    if (
      result.adapter !== adapter
      || result.accountId !== accountId
      || result.surfaceId !== args.surface.id
      || result.deliveryId !== deliveryId
    ) {
      logAdapterBoundaryFailure("error", "send_frame_mismatched_response");
      return {
        ok: false,
        error: `Adapter returned a mismatched adapter.send response: ${adapter}`,
        deliveryId,
        retryable: false,
      };
    }
    return result;
  } catch {
    return {
      ok: false,
      error: publicAdapterDeliveryError(adapter, true),
      deliveryId,
      retryable: true,
    };
  } finally {
    await Promise.all([
      cancelBinaryBody(responseBody, "adapter.send response body is unsupported"),
      responseBody === body
        ? Promise.resolve()
        : cancelBinaryBody(body, "adapter.send frame completed"),
    ]);
  }
}

function publicAdapterDeliveryError(adapter: string, retryable: boolean): string {
  const name = adapter === "whatsapp"
    ? "WhatsApp"
    : adapter.charAt(0).toUpperCase() + adapter.slice(1);
  return retryable
    ? `${name} delivery is temporarily unavailable`
    : `${name} rejected the delivery`;
}

async function rejectAdapterSend(body: BinaryBody | undefined, error: string): Promise<AdapterSendResult> {
  await cancelBinaryBody(body, error);
  return { ok: false, error, retryable: false };
}

function isCurrentAutomaticReplyDestination(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
): boolean {
  if (!ctx.processId || !ctx.processRunId) {
    return false;
  }
  const route = ctx.runRoutes.get(ctx.processRunId);
  if (route?.kind !== "adapter" || route.processId !== ctx.processId) {
    return false;
  }
  const { destination } = route;
  return destination.adapter === adapter
    && destination.accountId === accountId
    && destination.surface.kind === surface.kind
    && destination.surface.id === surface.id.trim()
    && (destination.surface.threadId ?? "") === (surface.threadId?.trim() ?? "");
}

function canSendToAdapterSurface(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
): boolean {
  const identity = ctx.identity;
  if (!identity) {
    return false;
  }
  if (identity.role === "service") {
    return true;
  }
  if (identity.role !== "user") {
    return false;
  }
  if (identity.process.uid === 0) {
    return true;
  }
  const ownerUid = resolveCallerOwnerUid(ctx);
  const links = ctx.adapters.identityLinks.list(ownerUid).filter((link) =>
    link.adapter.trim().toLowerCase() === adapter && link.accountId.trim() === accountId
  );
  if (links.length === 0) {
    return false;
  }
  return links.some((link) => identityLinkAllowsSurface(link, surface))
    || callerOwnsAdapterSurfaceRoute(ctx, adapter, accountId, surface, ownerUid, links);
}

function callerOwnsAdapterSurfaceRoute(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  ownerUid: number,
  links: IdentityLinkRecord[],
): boolean {
  return links.some((link) => {
    const route = ctx.adapters.surfaceRoutes.get({
      adapter,
      accountId,
      actorId: link.actorId,
      surfaceKind: surface.kind,
      surfaceId: surface.id.trim(),
      threadId: surface.threadId,
    });
    return route?.uid === ownerUid;
  });
}

export function validateAdapterMediaItems(
  media: AdapterMedia[] | undefined,
  direction: "inbound" | "outbound",
): void {
  if (media === undefined) return;
  if (!Array.isArray(media)) {
    throw new Error("Adapter media must be an array");
  }
  if (media.length > MAX_MESSAGE_MEDIA_ITEMS) {
    throw new Error(`Adapter media exceeds item limit (${MAX_MESSAGE_MEDIA_ITEMS})`);
  }

  for (const item of media) {
    if (!item || !["image", "audio", "video", "document"].includes(item.type)) {
      throw new Error("Adapter media has an invalid type");
    }
    if (!item.mimeType.trim()) {
      throw new Error("Adapter media requires mimeType");
    }
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) {
      throw new Error("Adapter media size must be a non-negative safe integer");
    }
    if (item.duration !== undefined && (!Number.isFinite(item.duration) || item.duration < 0)) {
      throw new Error("Adapter media duration must be a non-negative number");
    }
    if (item.body && item.size !== undefined && item.size !== item.body.length) {
      throw new Error("Adapter media size must match its binary body length");
    }
    if (direction === "inbound" && !item.body) {
      throw new Error("Inbound adapter media must include a binary body");
    }
    if (direction === "outbound" && !item.body && !item.url?.trim()) {
      throw new Error("Outbound adapter media must include a URL or binary body");
    }
    if (item.url) {
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        throw new Error("Adapter media URL is invalid");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Adapter media URL must use HTTP or HTTPS");
      }
    }
  }
}

