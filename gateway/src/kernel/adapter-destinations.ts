import type {
  AdapterMessageDestination,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { IdentityLinkRecord } from "./identity-links";
import type { SurfaceRouteRecord } from "./surface-routes";
import { resolveCallerOwnerUid } from "./context";
import { stableOpaqueId } from "../shared/stable-id";
import { z } from "zod";

const SURFACE_KINDS = new Set<AdapterSurfaceKind>([
  "dm",
  "group",
  "channel",
  "thread",
]);
const bindingSchema = z.object({ adapterSend: z.function() });
const surfaceKindSchema = z.enum(["dm", "group", "channel", "thread"]);
const adapterSurfaceSchema = z.object({
  kind: z.enum(["dm", "group", "channel", "thread"]),
  id: z.string().trim().min(1),
  threadId: z.string().optional(),
});

export type VisibleAdapterMessageDestination = {
  id: string;
  label: string;
  online: boolean;
  destination: AdapterMessageDestination;
};
type AdapterMessageRouteKey = {
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  threadId?: string;
};

export function normalizeAdapterMessageDestination(
  destination: AdapterMessageDestination,
): AdapterMessageDestination {
  if (!destination || destination.kind !== "adapter") {
    throw new Error("adapter destination is required");
  }
  const adapter = requiredText(destination.adapter, "adapter destination adapter").toLowerCase();
  const accountId = requiredText(destination.accountId, "adapter destination accountId");
  const actorId = requiredText(destination.actorId, "adapter destination actorId");
  return {
    kind: "adapter",
    adapter,
    accountId,
    actorId,
    surface: normalizeAdapterSurface(destination.surface),
  };
}

export function normalizeAdapterSurface(
  surface: AdapterSurface | undefined,
): AdapterSurface {
  const parsed = adapterSurfaceSchema.safeParse(surface);
  if (!parsed.success) {
    throw new Error("surface is required");
  }
  const threadId = optionalText(parsed.data.threadId);
  const normalized: AdapterSurface = {
    kind: parsed.data.kind,
    id: parsed.data.id,
  };
  if (threadId) normalized.threadId = threadId;
  return normalized;
}

export function assertAdapterMessageDestinationAccess(
  destination: AdapterMessageDestination,
  ownerUid: number,
  ctx: KernelContext,
): void {
  const link = ctx.adapters.identityLinks.get(
    destination.adapter,
    destination.accountId,
    destination.actorId,
  );
  const route = ctx.adapters.surfaceRoutes.get(
    {
      adapter: destination.adapter,
      accountId: destination.accountId,
      actorId: destination.actorId,
      surfaceKind: destination.surface.kind,
      surfaceId: destination.surface.id,
      threadId: destination.surface.threadId,
    },
  );
  if (
    link?.uid !== ownerUid
    || (!identityLinkAllowsSurface(link, destination.surface) && route?.uid !== ownerUid)
  ) {
    throw new Error("Adapter destination is not authorized");
  }
}

export async function listVisibleAdapterMessageDestinations(
  ctx: KernelContext,
  options: { includeOffline?: boolean; includeUnavailable?: boolean } = {},
): Promise<VisibleAdapterMessageDestination[]> {
  if (!ctx.identity || ctx.identity.role !== "user") {
    return [];
  }
  const ownerUid = resolveCallerOwnerUid(ctx);
  const links = ctx.adapters.identityLinks.list(ownerUid);
  const candidateMap = new Map<string, VisibleAdapterMessageDestination>();
  const addCandidate = (link: IdentityLinkRecord, surface: AdapterSurface): void => {
    const adapter = link.adapter.trim().toLowerCase();
    const accountId = link.accountId.trim();
    const status = ctx.adapters.status.get(adapter, accountId);
    const online = status?.connected === true && status.authenticated === true;
    if (!options.includeOffline && !online) {
      return;
    }
    if (!options.includeUnavailable && !adapterSendServiceAvailable(ctx, adapter)) {
      return;
    }
    const destination = normalizeAdapterMessageDestination({
      kind: "adapter",
      adapter,
      accountId,
      actorId: link.actorId,
      surface,
    });
    const key = destinationKey(destination);
    candidateMap.set(key, {
      id: "",
      label: adapterMessageDestinationLabel(destination),
      online,
      destination,
    });
  };

  for (const link of links) {
    const surface = linkedSurface(link);
    if (surface) addCandidate(link, surface);
  }
  const linksByKey = new Map(links.map((link) => [
    `${link.adapter.trim().toLowerCase()}\0${link.accountId.trim()}\0${link.actorId.trim()}`,
    link,
  ]));
  for (const route of ctx.adapters.surfaceRoutes.list(ownerUid)) {
    const link = linksByKey.get(
      `${route.adapter.trim().toLowerCase()}\0${route.accountId.trim()}\0${route.actorId.trim()}`,
    );
    if (!link) continue;
    addCandidate(link, {
      kind: route.surfaceKind,
      id: route.surfaceId,
    });
  }

  return (await Promise.all([...candidateMap.values()]
    .map(async (candidate) => ({
      ...candidate,
      id: await adapterMessageDestinationId(candidate.destination, ownerUid),
    }))))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function resolveVisibleAdapterMessageDestination(
  query: string,
  ctx: KernelContext,
  options: { includeOffline?: boolean; includeUnavailable?: boolean } = {},
): Promise<VisibleAdapterMessageDestination> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    throw new Error("message target is required");
  }
  const destinations = await listVisibleAdapterMessageDestinations(ctx, options);
  const exact = destinations.filter((entry) =>
    entry.id.toLowerCase() === needle
    || entry.destination.adapter === needle
    || entry.label.toLowerCase() === needle
  );
  const matches = exact.length > 0
    ? exact
    : destinations.filter((entry) =>
      entry.id.toLowerCase().includes(needle)
      || entry.label.toLowerCase().includes(needle)
    );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`No authorized message destination matches: ${query}`);
  }
  throw new Error(
    `Message destination is ambiguous: ${matches.map((entry) => entry.id).join(", ")}`,
  );
}

export function updateAdapterMessageDestinationRoute(
  destination: AdapterMessageDestination,
  pid: string | null,
  ctx: KernelContext,
): SurfaceRouteRecord | null {
  const normalized = normalizeAdapterMessageDestination(destination);
  const ownerUid = resolveCallerOwnerUid(ctx);
  assertAdapterMessageDestinationAccess(normalized, ownerUid, ctx);
  const key = adapterMessageDestinationRouteKey(normalized);
  const existing = ctx.adapters.surfaceRoutes.get(key);
  if (existing && existing.uid !== ownerUid) {
    throw new Error("Adapter route ownership does not match the linked identity");
  }
  if (!pid) {
    if (normalized.surface.kind === "dm") {
      throw new Error("Use /ship in the private DM to return to Ship");
    }
    if (existing) ctx.adapters.surfaceRoutes.clearRoute(key);
    return null;
  }

  const process = ctx.procs.get(pid);
  if (!process || process.ownerUid !== ownerUid) {
    throw new Error("Process not found");
  }
  if (!process.interactive) {
    throw new Error("Adapter destinations can only route to interactive processes");
  }

  if (normalized.surface.kind === "dm") {
    return setPrivateDmWorkRoute(normalized, process, existing, ownerUid, ctx);
  }

  return ctx.adapters.surfaceRoutes.setRoute({
    ...key,
    uid: ownerUid,
    pid: process.processId,
    mode: "surface",
    updatedByUid: ctx.identity!.process.uid,
  });
}

function setPrivateDmWorkRoute(
  destination: AdapterMessageDestination,
  target: NonNullable<ReturnType<KernelContext["procs"]["get"]>>,
  existing: SurfaceRouteRecord | null,
  ownerUid: number,
  ctx: KernelContext,
): SurfaceRouteRecord {
  if (target.isPersonalController) {
    throw new Error("A private DM direct line must target a non-personal work process");
  }
  const callerPid = ctx.processId;
  const runId = ctx.processRunId;
  const controller = ctx.procs.getPersonalController(ownerUid);
  if (
    !callerPid
    || !runId
    || controller?.processId !== callerPid
    || !controller.isPersonalController
    || controller.activeRunId !== runId
  ) {
    throw new Error("Only the personal intelligence can open a private DM direct line");
  }

  const runRoute = ctx.runRoutes.get(runId);
  if (
    runRoute?.kind !== "adapter"
    || runRoute.processId !== callerPid
    || runRoute.uid !== ownerUid
    || !runRoute.replyToId
    || !sameAdapterMessageDestination(runRoute.destination, destination)
  ) {
    throw new Error("A private DM direct line requires the exact conversation that started this run");
  }

  const latest = ctx.adapters.privateDestinations.get(ownerUid);
  if (
    !latest
    || latest.messageId !== runRoute.replyToId
    || !sameAdapterMessageDestination(latest.destination, destination)
    || !ctx.adapters.ingressReceipts.isLatestPrivateMessage(destination, runRoute.replyToId)
  ) {
    throw new Error("The private conversation changed before the direct line could be opened");
  }

  if (existing?.mode === "work" && existing.pid === target.processId) {
    return existing;
  }
  if (existing) {
    throw new Error("The private conversation selection changed before the direct line could be opened");
  }

  return ctx.adapters.surfaceRoutes.setRoute({
    ...adapterMessageDestinationRouteKey(destination),
    uid: ownerUid,
    pid: target.processId,
    mode: "work",
    updatedByUid: ctx.identity!.process.uid,
  });
}

function sameAdapterMessageDestination(
  left: AdapterMessageDestination,
  right: AdapterMessageDestination,
): boolean {
  const normalizedLeft = normalizeAdapterMessageDestination(left);
  const normalizedRight = normalizeAdapterMessageDestination(right);
  return normalizedLeft.adapter === normalizedRight.adapter
    && normalizedLeft.accountId === normalizedRight.accountId
    && normalizedLeft.actorId === normalizedRight.actorId
    && normalizedLeft.surface.kind === normalizedRight.surface.kind
    && normalizedLeft.surface.id === normalizedRight.surface.id
    && (normalizedLeft.surface.threadId ?? "") === (normalizedRight.surface.threadId ?? "");
}

export async function adapterMessageDestinationId(
  destination: AdapterMessageDestination,
  ownerUid: number,
): Promise<string> {
  const normalized = normalizeAdapterMessageDestination(destination);
  return stableOpaqueId("message-destination", [
    ownerUid,
    normalized.adapter,
    normalized.accountId,
    normalized.actorId,
    normalized.surface.kind,
    normalized.surface.id,
    normalized.surface.threadId ?? null,
  ]);
}

export function adapterMessageDestinationLabel(
  destination: AdapterMessageDestination,
): string {
  const normalized = normalizeAdapterMessageDestination(destination);
  return `${adapterDisplayName(normalized.adapter)} ${surfaceLabel(normalized.surface)}`;
}

export function identityLinkAllowsSurface(
  link: IdentityLinkRecord,
  surface: AdapterSurface,
): boolean {
  const linkedSurfaceKind = metadataString(link.metadata, "surfaceKind");
  const linkedSurfaceId = metadataString(link.metadata, "surfaceId");
  if (linkedSurfaceKind && linkedSurfaceId) {
    return linkedSurfaceKind === surface.kind && linkedSurfaceId === surface.id.trim();
  }
  return false;
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized || undefined;
}

function metadataString(
  metadata: IdentityLinkRecord["metadata"],
  key: string,
): string {
  const value = metadata?.[key];
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data.trim() : "";
}

function linkedSurface(link: IdentityLinkRecord): AdapterSurface | null {
  const parsedKind = surfaceKindSchema.safeParse(metadataString(link.metadata, "surfaceKind"));
  if (!parsedKind.success) return null;
  const kind = parsedKind.data;
  const id = metadataString(link.metadata, "surfaceId");
  const threadId = metadataString(link.metadata, "threadId");
  if (SURFACE_KINDS.has(kind) && id) {
    const linked: AdapterSurface = {
      kind,
      id,
    };
    if (threadId) linked.threadId = threadId;
    return linked;
  }
  return null;
}

function destinationKey(destination: AdapterMessageDestination): string {
  return [
    destination.adapter,
    destination.accountId,
    destination.actorId,
    destination.surface.kind,
    destination.surface.id,
    destination.surface.threadId ?? "",
  ].join("\0");
}

export function adapterMessageDestinationRouteKey(destination: AdapterMessageDestination): AdapterMessageRouteKey {
  const key: AdapterMessageRouteKey = {
    adapter: destination.adapter,
    accountId: destination.accountId,
    actorId: destination.actorId,
    surfaceKind: destination.surface.kind,
    surfaceId: destination.surface.id,
  };
  if (destination.surface.threadId) key.threadId = destination.surface.threadId;
  return key;
}

function adapterSendServiceAvailable(ctx: KernelContext, adapter: string): boolean {
  const key = `CHANNEL_${adapter.toUpperCase()}`;
  const binding = Object.entries(ctx.env).find(([name]) => name === key)?.[1];
  return bindingSchema.safeParse(binding).success;
}

function adapterDisplayName(adapter: string): string {
  if (adapter === "whatsapp") return "WhatsApp";
  if (adapter === "discord") return "Discord";
  return adapter.charAt(0).toUpperCase() + adapter.slice(1);
}

function surfaceLabel(surface: AdapterSurface): string {
  if (surface.kind === "dm") return "direct message";
  return surface.kind;
}
