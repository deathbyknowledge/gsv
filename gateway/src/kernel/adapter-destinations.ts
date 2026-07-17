import type {
  AdapterMessageDestination,
  AdapterSurface,
  AdapterSurfaceKind,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { IdentityLinkRecord } from "./identity-links";
import { resolveCallerOwnerUid } from "./context";
import { stableOpaqueId } from "../shared/stable-id";

const SURFACE_KINDS = new Set<AdapterSurfaceKind>([
  "dm",
  "group",
  "channel",
  "thread",
]);

export type VisibleAdapterMessageDestination = {
  id: string;
  label: string;
  online: boolean;
  destination: AdapterMessageDestination;
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
  if (!surface || typeof surface !== "object") {
    throw new Error("surface is required");
  }
  if (!SURFACE_KINDS.has(surface.kind)) {
    throw new Error("surface.kind is invalid");
  }
  if (typeof surface.id !== "string" || !surface.id.trim()) {
    throw new Error("surface.id is required");
  }
  if (surface.threadId !== undefined && typeof surface.threadId !== "string") {
    throw new Error("surface.threadId must be a string");
  }
  const threadId = optionalText(surface.threadId);
  return {
    kind: surface.kind,
    id: surface.id.trim(),
    ...(threadId ? { threadId } : {}),
  };
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
  options: { includeOffline?: boolean } = {},
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
    if (!adapterSendServiceAvailable(ctx, adapter)) {
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
      label: `${adapterDisplayName(adapter)} ${surfaceLabel(destination.surface)}`,
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
      ...(route.threadId ? { threadId: route.threadId } : {}),
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
  options: { includeOffline?: boolean } = {},
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
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function linkedSurface(link: IdentityLinkRecord): AdapterSurface | null {
  const kind = metadataString(link.metadata, "surfaceKind") as AdapterSurfaceKind;
  const id = metadataString(link.metadata, "surfaceId");
  const threadId = metadataString(link.metadata, "threadId");
  if (SURFACE_KINDS.has(kind) && id) {
    return {
      kind,
      id,
      ...(threadId ? { threadId } : {}),
    };
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

function adapterSendServiceAvailable(ctx: KernelContext, adapter: string): boolean {
  const key = `CHANNEL_${adapter.toUpperCase()}`;
  const binding = (ctx.env as unknown as Record<string, unknown>)[key];
  return Boolean(
    binding
    && typeof binding === "object"
    && typeof (binding as { adapterSend?: unknown }).adapterSend === "function",
  );
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
