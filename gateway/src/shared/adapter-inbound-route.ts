import type {
  AdapterInboundArgs,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame } from "../protocol/frames";

const ADAPTER_MAX_CHARACTERS = 64;
const ROUTE_SEGMENT_MAX_CHARACTERS = 512;
const ADAPTER_SURFACE_KINDS = new Set<AdapterSurfaceKind>([
  "dm",
  "group",
  "channel",
  "thread",
]);
const ADAPTER_ROUTE_METADATA_KEYS = new Set([
  "adapter",
  "accountId",
  "actorId",
  "frameId",
  "surfaceKind",
  "surfaceId",
]);

export const ADAPTER_INBOUND_GATEWAY_SOURCE = "scoped-adapter-entrypoint";

export type AdapterInboundRouteMetadata = {
  adapter: string;
  accountId: string;
  actorId: string;
  frameId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
};

export type AdapterInboundRouteResult =
  | {
      kind: "active";
      authorization: string;
      targetKernelName: string;
      username: string;
      ownerUid: number;
      generation: number;
      linkGeneration: number;
    }
  | { kind: "legacy" }
  | {
      kind: "response";
      data:
        | { ok: true; droppedReason: "unlinked_actor" }
        | {
            ok: true;
            challenge: {
              code: string;
              prompt: string;
              expiresAt: number;
            };
          };
    }
  | { kind: "error"; code: number; message: string };

/**
 * Extract the small routing envelope from an adapter frame. Message text,
 * media, reply context, and other payload fields deliberately stay in the
 * original frame and never enter this result.
 */
export function adapterInboundRouteMetadata(
  frame: RequestFrame<"adapter.inbound"> | undefined,
): AdapterInboundRouteMetadata | null {
  if (
    !frame
    || frame.type !== "req"
    || frame.call !== "adapter.inbound"
    || typeof frame.id !== "string"
  ) {
    return null;
  }
  const args = frame.args as AdapterInboundArgs;
  const message = args?.message;
  const surface = message && typeof message === "object"
    ? message.surface
    : null;
  const frameId = normalizeBoundedSegment(frame.id);
  const adapter = typeof args?.adapter === "string"
    ? args.adapter.trim().toLowerCase()
    : "";
  const accountId = normalizeBoundedSegment(args?.accountId);
  const surfaceId = normalizeBoundedSegment(surface?.id);
  const surfaceKind = surface?.kind;
  const rawActorId = message?.actor?.id;
  const normalizedActorId = normalizeBoundedSegment(rawActorId);
  const invalidExplicitActorId = typeof rawActorId === "string"
    && rawActorId.trim().length > 0
    && !normalizedActorId;
  const actorId = normalizedActorId
    || (surfaceKind === "dm" ? surfaceId : "");
  if (
    !frameId
    || frame.id !== frameId
    || !adapter
    || adapter.length > ADAPTER_MAX_CHARACTERS
    || !accountId
    || !surfaceId
    || surface?.id !== surfaceId
    || !surfaceKind
    || !ADAPTER_SURFACE_KINDS.has(surfaceKind)
    || invalidExplicitActorId
    || !actorId
  ) {
    return null;
  }
  return {
    adapter,
    accountId,
    actorId,
    frameId,
    surfaceKind,
    surfaceId,
  };
}

/** Validate the exact metadata-only Master RPC boundary. */
export function normalizeAdapterInboundRouteMetadata(
  input: unknown,
): AdapterInboundRouteMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== ADAPTER_ROUTE_METADATA_KEYS.size
    || keys.some((key) => !ADAPTER_ROUTE_METADATA_KEYS.has(key))
  ) {
    return null;
  }
  const adapter = typeof record.adapter === "string"
    ? record.adapter.trim().toLowerCase()
    : "";
  const accountId = normalizeBoundedSegment(record.accountId);
  const actorId = normalizeBoundedSegment(record.actorId);
  const frameId = normalizeBoundedSegment(record.frameId);
  const surfaceId = normalizeBoundedSegment(record.surfaceId);
  const surfaceKind = record.surfaceKind;
  if (
    !adapter
    || record.adapter !== adapter
    || adapter.length > ADAPTER_MAX_CHARACTERS
    || !accountId
    || record.accountId !== accountId
    || !actorId
    || record.actorId !== actorId
    || !frameId
    || record.frameId !== frameId
    || !surfaceId
    || record.surfaceId !== surfaceId
    || typeof surfaceKind !== "string"
    || !ADAPTER_SURFACE_KINDS.has(surfaceKind as AdapterSurfaceKind)
  ) {
    return null;
  }
  return {
    adapter,
    accountId,
    actorId,
    frameId,
    surfaceKind: surfaceKind as AdapterSurfaceKind,
    surfaceId,
  };
}

export function sameAdapterInboundRouteMetadata(
  left: AdapterInboundRouteMetadata,
  right: AdapterInboundRouteMetadata,
): boolean {
  return left.adapter === right.adapter
    && left.accountId === right.accountId
    && left.actorId === right.actorId
    && left.frameId === right.frameId
    && left.surfaceKind === right.surfaceKind
    && left.surfaceId === right.surfaceId;
}

function normalizeBoundedSegment(input: unknown): string {
  if (typeof input !== "string") return "";
  const normalized = input.trim();
  return normalized.length <= ROUTE_SEGMENT_MAX_CHARACTERS ? normalized : "";
}
