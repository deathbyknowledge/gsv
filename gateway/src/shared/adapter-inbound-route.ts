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

export type AdapterInboundRouteMetadata = {
  adapter: string;
  accountId: string;
  actorId: string;
  frameId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
};

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

function normalizeBoundedSegment(input: unknown): string {
  if (typeof input !== "string") return "";
  const normalized = input.trim();
  return normalized.length <= ROUTE_SEGMENT_MAX_CHARACTERS ? normalized : "";
}
