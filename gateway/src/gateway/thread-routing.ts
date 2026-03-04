import { resolveAgentIdFromBinding } from "../config/parsing";
import type { ChannelInboundParams, ChatType, PeerInfo } from "../protocol/channel";
import type { Gateway } from "./do";
import type { GroupMode, RouteTupleV1, ThreadMode } from "./registry-store";
import {
  legacySessionKeyFromStateId,
  sessionDoNameFromStateId,
  stateIdFromLegacySessionKey,
} from "./thread-state";
import { buildSessionKeyFromChannel } from "./channel-transport";
import {
  buildChannelPrincipalId,
  buildPendingBindingKey,
  normalizeId,
  normalizeChannelSenderId,
} from "./identity";

const SUPPORTED_PEER_KINDS: ReadonlySet<ChatType> = new Set([
  "dm",
  "group",
  "channel",
  "thread",
]);

export type DeliveryTarget = "same-surface";

export type ResolvedInboundRoute = {
  status: "ok";
  principalId: string;
  surfaceId: string;
  spaceId: string;
  agentId: string;
  threadId: string;
  stateId: string;
  stateDoName: string;
  legacySessionKey?: string;
  routeHash: string;
  threadMode: string;
  deliveryTarget: DeliveryTarget;
};

export type BlockedInboundRoute = {
  status: "blocked";
  state: "unpaired" | "allowed_unbound";
  reason?: string;
  principalId?: string;
  surfaceId?: string;
};

export type InboundThreadRouteResult =
  | ResolvedInboundRoute
  | BlockedInboundRoute;

function normalizeOptionalId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizePeerKind(value: string): ChatType | undefined {
  const normalized = normalizeId(value);
  if (SUPPORTED_PEER_KINDS.has(normalized as ChatType)) {
    return normalized as ChatType;
  }
  return undefined;
}

function buildPrincipalId(
  channel: string,
  accountId: string,
  senderId: string,
): string {
  return buildChannelPrincipalId(channel, accountId, senderId);
}

function ensurePendingBinding(
  gw: Gateway,
  params: ChannelInboundParams,
  principalId: string,
  senderId: string,
): void {
  const key = buildPendingBindingKey(params.channel, senderId);
  const existing = gw.pendingPairs[key];
  gw.pendingPairs[key] = {
    channel: normalizeId(params.channel),
    accountId: normalizeId(params.accountId),
    senderId: normalizeChannelSenderId(senderId),
    principalId: normalizeId(principalId),
    senderName: existing?.senderName ?? params.sender?.name ?? params.peer.name,
    stage: "binding",
    requestedAt: existing?.requestedAt ?? Date.now(),
    firstMessage: existing?.firstMessage ?? params.message.text?.slice(0, 200),
  };
}

function buildSurfaceId(
  params: ChannelInboundParams,
  peerKind: ChatType,
): string {
  return [
    "channel",
    normalizeId(params.channel),
    normalizeId(params.accountId),
    peerKind,
    normalizeId(params.peer.id),
  ].join(":");
}

function parseModeHint(
  messageText: string | undefined,
): "none" | "group" | "me" {
  const raw = (messageText ?? "").trim().toLowerCase();
  if (raw.startsWith("/group")) return "group";
  if (raw.startsWith("/me")) return "me";
  return "none";
}

function resolveDefaultSpaceId(gw: Gateway): string {
  const configured = gw.getConfigPath("spaces.defaultSpaceId");
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().toLowerCase();
  }
  return "default";
}

function resolvePrincipalBindingPolicy(
  gw: Gateway,
  params: ChannelInboundParams,
): "manual" | "invite" | "auto-guest" | "auto-bind-default" {
  const channelPolicy = gw.getConfigPath(
    `channels.${normalizeId(params.channel)}.principalBindingPolicy`,
  );
  if (
    channelPolicy === "manual" ||
    channelPolicy === "invite" ||
    channelPolicy === "auto-guest" ||
    channelPolicy === "auto-bind-default"
  ) {
    return channelPolicy;
  }

  const hasSpacesConfig = gw.getConfigPath("spaces") !== undefined;
  if (!hasSpacesConfig) {
    // Compatibility mode for existing deployments.
    return "auto-bind-default";
  }

  return "manual";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function requiresConversationBinding(
  gw: Gateway,
  channel: string,
  peerKind: ChatType,
): boolean {
  const routingValue = gw.getConfigPath("routing.requireConversationBinding");
  if (!routingValue || typeof routingValue !== "object") {
    return false;
  }

  const byChannel = (routingValue as Record<string, unknown>)[normalizeId(channel)];
  if (typeof byChannel === "boolean") {
    return byChannel;
  }
  if (!byChannel || typeof byChannel !== "object") {
    return false;
  }

  return asBoolean((byChannel as Record<string, unknown>)[peerKind]);
}

function resolveRedactedRouteTuple(
  tuple: RouteTupleV1,
  surfaceHash: string,
): {
  v: 1;
  spaceId: string;
  agentId: string;
  threadMode: string;
  hasActor: boolean;
  surfaceHash: string;
} {
  return {
    v: 1,
    spaceId: tuple.spaceId,
    agentId: tuple.agentId,
    threadMode: tuple.threadMode,
    hasActor: Boolean(tuple.actorId),
    surfaceHash,
  };
}

function determineThreadMode(params: {
  peerKind: ChatType;
  modeHint: "none" | "group" | "me";
  boundMode?: GroupMode | undefined;
  dmDefaultMode: ThreadMode | (string & {});
  groupDefaultMode: ThreadMode | (string & {});
}): ThreadMode | (string & {}) {
  if (params.modeHint === "me") {
    return "per-user";
  }
  if (params.peerKind === "dm") {
    return params.dmDefaultMode;
  }
  const configuredMode = params.boundMode ?? params.groupDefaultMode;
  if (configuredMode === "hybrid") {
    return "group-shared";
  }
  return configuredMode;
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function serializeCanonicalRouteTupleV1(tuple: RouteTupleV1): string {
  const canonicalEntries: Array<[string, string | number]> = [
    ["agentId", normalizeId(tuple.agentId)],
    ["spaceId", normalizeId(tuple.spaceId)],
    ["surfaceId", normalizeId(tuple.surfaceId)],
    ["threadMode", normalizeId(String(tuple.threadMode))],
    ["v", tuple.v],
  ];

  const normalizedActorId = normalizeOptionalId(tuple.actorId);
  if (normalizedActorId) {
    canonicalEntries.push(["actorId", normalizedActorId]);
  }

  canonicalEntries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );

  const canonicalObject: Record<string, string | number> = {};
  for (const [key, value] of canonicalEntries) {
    canonicalObject[key] = value;
  }

  return JSON.stringify(canonicalObject);
}

async function resolveRouteHash(tuple: RouteTupleV1): Promise<{
  routeHash: string;
  surfaceHash: string;
}> {
  const canonicalTupleJson = serializeCanonicalRouteTupleV1(tuple);
  const [routeHash, surfaceHash] = await Promise.all([
    sha256Hex(canonicalTupleJson),
    sha256Hex(tuple.surfaceId),
  ]);
  return { routeHash, surfaceHash };
}

export async function resolveInboundThreadRoute(
  gw: Gateway,
  params: ChannelInboundParams,
): Promise<InboundThreadRouteResult> {
  const senderId = params.sender?.id ?? params.peer.id;
  const principalId = buildPrincipalId(
    params.channel,
    params.accountId,
    senderId,
  );

  const peerKind = normalizePeerKind(params.peer.kind);
  if (!peerKind) {
    return {
      status: "blocked",
      state: "unpaired",
      reason: "unsupported-peer-kind",
      principalId,
    };
  }

  const normalizedPeer: PeerInfo = {
    ...params.peer,
    kind: peerKind,
    id: normalizeId(params.peer.id),
    name: params.peer.name,
    handle: params.peer.handle,
  };
  const surfaceId = buildSurfaceId(params, peerKind);

  const registry = gw.registryStore;
  const config = gw.getFullConfig();
  const modeHint = parseModeHint(params.message.text);
  const boundConversation = registry.getConversationBinding(surfaceId);

  let principalProfile = registry.getPrincipalProfile(principalId);
  if (!principalProfile) {
    const bindingPolicy = resolvePrincipalBindingPolicy(gw, params);
    if (bindingPolicy === "manual" || bindingPolicy === "invite") {
      ensurePendingBinding(gw, params, principalId, senderId);
      return {
        status: "blocked",
        state: "allowed_unbound",
        reason: "principal-unbound",
        principalId,
        surfaceId,
      };
    }

    const defaultAgentId = resolveAgentIdFromBinding(
      config,
      params.channel,
      params.accountId,
      normalizedPeer,
    );
    principalProfile = registry.upsertPrincipalProfile(principalId, {
      homeSpaceId: resolveDefaultSpaceId(gw),
      homeAgentId: normalizeOptionalId(defaultAgentId),
      status: "bound",
    });
    registry.ensureMember(
      principalProfile.homeSpaceId,
      principalId,
      bindingPolicy === "auto-guest" ? "guest" : "member",
    );
  }

  if (principalProfile.status === "allowed_unbound") {
    ensurePendingBinding(gw, params, principalId, senderId);
    return {
      status: "blocked",
      state: "allowed_unbound",
      reason: "principal-unbound",
      principalId,
      surfaceId,
    };
  }

  if (
    peerKind !== "dm" &&
    !boundConversation &&
    requiresConversationBinding(gw, params.channel, peerKind)
  ) {
    return {
      status: "blocked",
      state: "allowed_unbound",
      reason: "conversation-not-bound",
      principalId,
      surfaceId,
    };
  }

  const selectedSpaceId =
    normalizeOptionalId(
      modeHint === "me"
        ? principalProfile.homeSpaceId
        : boundConversation?.spaceId ?? principalProfile.homeSpaceId,
    ) ?? resolveDefaultSpaceId(gw);

  const selectedAgentId =
    normalizeOptionalId(
      (modeHint === "me"
        ? principalProfile.homeAgentId
        : boundConversation?.agentId ?? principalProfile.homeAgentId) ??
        resolveAgentIdFromBinding(
          config,
          params.channel,
          params.accountId,
          normalizedPeer,
        ),
    ) ?? "main";

  if (
    !registry.isOwner(principalId) &&
    !registry.isMember(selectedSpaceId, principalId)
  ) {
    ensurePendingBinding(gw, params, principalId, senderId);
    return {
      status: "blocked",
      state: "allowed_unbound",
      reason: "not-a-member-of-space",
      principalId,
      surfaceId,
    };
  }

  const dmDefaultMode =
    normalizeOptionalId(gw.getConfigPath("routing.dmDefaultMode") as string | undefined) ??
    "per-user";
  const groupDefaultMode =
    normalizeOptionalId(gw.getConfigPath("routing.groupDefaultMode") as string | undefined) ??
    "group-shared";
  const threadMode = determineThreadMode({
    peerKind,
    modeHint,
    boundMode: boundConversation?.groupMode,
    dmDefaultMode,
    groupDefaultMode,
  });

  const actorId =
    threadMode === "per-user" || threadMode === "per-user-in-group"
      ? principalId
      : undefined;

  const routeTuple: RouteTupleV1 = {
    v: 1,
    spaceId: selectedSpaceId,
    agentId: selectedAgentId,
    surfaceId,
    threadMode,
    ...(actorId ? { actorId } : {}),
  };

  const { routeHash, surfaceHash } = await resolveRouteHash(routeTuple);

  const legacySessionKey = buildSessionKeyFromChannel(
    gw,
    selectedAgentId,
    params.channel,
    params.accountId,
    normalizedPeer,
    senderId,
  );

  const now = Date.now();
  let threadRoute = registry.getThreadRoute(routeHash);
  let threadId = threadRoute?.threadId;
  let threadMeta = threadId ? registry.getThreadMeta(threadId) : undefined;

  if (!threadId) {
    const legacyThreadId = registry.getLegacyThreadId(legacySessionKey);
    if (legacyThreadId) {
      threadId = legacyThreadId;
      threadMeta = registry.getThreadMeta(threadId);
      if (!threadMeta) {
        threadMeta = {
          stateId: stateIdFromLegacySessionKey(legacySessionKey),
          spaceId: selectedSpaceId,
          agentId: selectedAgentId,
          createdAt: now,
          lastActiveAt: now,
          legacy: true,
          legacySessionKey,
        };
        registry.putThreadMeta(threadId, threadMeta);
      }
      registry.putLegacyThreadId(legacySessionKey, threadId);
    } else {
      const legacySessionRegistryEntry = gw.sessionRegistry[legacySessionKey];
      if (legacySessionRegistryEntry) {
        threadId =
          normalizeOptionalId(legacySessionRegistryEntry.threadId) ??
          crypto.randomUUID();

        const importedStateId =
          normalizeOptionalId(legacySessionRegistryEntry.stateId) ??
          stateIdFromLegacySessionKey(legacySessionKey);

        threadMeta = registry.getThreadMeta(threadId) ?? {
          stateId: importedStateId,
          spaceId: selectedSpaceId,
          agentId: selectedAgentId,
          createdAt: legacySessionRegistryEntry.createdAt,
          lastActiveAt: legacySessionRegistryEntry.lastActiveAt,
          legacy: true,
          legacySessionKey,
        };

        registry.putThreadMeta(threadId, threadMeta);
        registry.putLegacyThreadId(legacySessionKey, threadId);

        gw.sessionRegistry[legacySessionKey] = {
          ...legacySessionRegistryEntry,
          threadId,
          stateId: threadMeta.stateId,
          spaceId: selectedSpaceId,
          agentId: selectedAgentId,
        };
      } else {
        threadId = crypto.randomUUID();
        threadMeta = {
          stateId: `thread:${threadId}`,
          spaceId: selectedSpaceId,
          agentId: selectedAgentId,
          createdAt: now,
          lastActiveAt: now,
          legacy: false,
        };
        registry.putThreadMeta(threadId, threadMeta);
      }
    }

    registry.putThreadRoute(routeHash, {
      threadId,
      routeTuple: resolveRedactedRouteTuple(routeTuple, surfaceHash),
      createdAt: now,
    });
    threadRoute = registry.getThreadRoute(routeHash);
  }

  if (!threadId) {
    return {
      status: "blocked",
      state: "allowed_unbound",
      reason: "thread-resolution-failed",
      principalId,
      surfaceId,
    };
  }

  if (!threadMeta) {
    const isLegacyThread = registry.getLegacyThreadId(legacySessionKey) === threadId;
    threadMeta = {
      stateId: isLegacyThread
        ? stateIdFromLegacySessionKey(legacySessionKey)
        : `thread:${threadId}`,
      spaceId: selectedSpaceId,
      agentId: selectedAgentId,
      createdAt: now,
      lastActiveAt: now,
      legacy: isLegacyThread,
      legacySessionKey: isLegacyThread ? legacySessionKey : undefined,
    };
    registry.putThreadMeta(threadId, threadMeta);
    if (isLegacyThread) {
      registry.putLegacyThreadId(legacySessionKey, threadId);
    }
  } else {
    registry.touchThreadMeta(threadId, now);
  }

  const stateId = threadMeta.stateId;
  const stateDoName = sessionDoNameFromStateId(stateId);
  const resolvedLegacySessionKey =
    threadMeta.legacySessionKey ?? legacySessionKeyFromStateId(stateId);

  return {
    status: "ok",
    principalId,
    surfaceId,
    spaceId: selectedSpaceId,
    agentId: selectedAgentId,
    threadId,
    stateId,
    stateDoName,
    legacySessionKey: resolvedLegacySessionKey,
    routeHash,
    threadMode,
    deliveryTarget: "same-surface",
  };
}
