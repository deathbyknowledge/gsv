import { normalizeE164, resolveAgentIdFromBinding } from "../../config/parsing";
import type { SpaceMember } from "../registry-store";
import type { PeerInfo } from "../../protocol/channel";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";
import { claimInviteForPrincipal, createInvite } from "../invites";
import { runRegistryBackfill, runRegistryRepair } from "../registry-maintenance";

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptionalId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeId(value);
  return normalized || undefined;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const normalized = normalizeOptionalId(value);
  if (!normalized) {
    throw new RpcError(400, `${field} required`);
  }
  return normalized;
}

function paginate<T>(
  items: T[],
  offset: number | undefined,
  limit: number | undefined,
): T[] {
  const safeOffset = Math.max(0, offset ?? 0);
  const safeLimit = Math.max(1, limit ?? 100);
  return items.slice(safeOffset, safeOffset + safeLimit);
}

function resolveDefaultSpaceId(rawValue: unknown): string {
  if (typeof rawValue === "string" && rawValue.trim()) {
    return normalizeId(rawValue);
  }
  return "default";
}

function buildPrincipalIdFromChannel(
  channel: string,
  accountId: string,
  senderId: string,
): string {
  const normalizedSender = normalizeId(normalizeE164(senderId) || senderId);
  return `channel:${normalizeId(channel)}:${normalizeId(accountId)}:${normalizedSender}`;
}

export const handlePrincipalProfileGet: Handler<"principal.profile.get"> = ({
  gw,
  params,
}) => {
  const principalId = requireNonEmpty(params?.principalId, "principalId");
  const profile = gw.registryStore.getPrincipalProfile(principalId);
  return { principalId, profile };
};

export const handlePrincipalProfileList: Handler<"principal.profile.list"> = ({
  gw,
  params,
}) => {
  const entries = Object.entries(gw.registryStore.listPrincipalProfiles())
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .map(([principalId, profile]) => ({ principalId, profile }));

  return {
    profiles: paginate(entries, params?.offset, params?.limit),
    count: entries.length,
  };
};

export const handlePrincipalProfilePut: Handler<"principal.profile.put"> = ({
  gw,
  params,
}) => {
  const principalId = requireNonEmpty(params?.principalId, "principalId");
  const homeSpaceId = requireNonEmpty(params?.homeSpaceId, "homeSpaceId");
  const homeAgentId = normalizeOptionalId(params?.homeAgentId);
  const status = params?.status ?? "bound";
  if (status !== "bound" && status !== "allowed_unbound") {
    throw new RpcError(400, "status must be 'bound' or 'allowed_unbound'");
  }

  const profile = gw.registryStore.upsertPrincipalProfile(principalId, {
    homeSpaceId,
    homeAgentId,
    status,
  });

  return { ok: true, principalId, profile };
};

export const handlePrincipalProfileDelete: Handler<"principal.profile.delete"> = ({
  gw,
  params,
}) => {
  const principalId = requireNonEmpty(params?.principalId, "principalId");
  const removed = gw.registryStore.deletePrincipalProfile(principalId);
  return { ok: true, principalId, removed };
};

export const handleSpaceMembersList: Handler<"space.members.list"> = ({
  gw,
  params,
}) => {
  const normalizedSpaceId = normalizeOptionalId(params?.spaceId);
  const memberRows: Array<{ spaceId: string; principalId: string; member: SpaceMember }> = [];

  if (normalizedSpaceId) {
    const members = gw.registryStore.getSpaceMembers(normalizedSpaceId);
    for (const [principalId, member] of Object.entries(members)) {
      memberRows.push({ spaceId: normalizedSpaceId, principalId, member });
    }
  } else {
    const spaces = gw.registryStore.listSpaceMembers();
    for (const [spaceId, members] of Object.entries(spaces)) {
      for (const [principalId, member] of Object.entries(members)) {
        memberRows.push({ spaceId, principalId, member });
      }
    }
  }

  memberRows.sort((left, right) => {
    const ts = right.member.updatedAt - left.member.updatedAt;
    if (ts !== 0) return ts;
    return `${left.spaceId}:${left.principalId}`.localeCompare(
      `${right.spaceId}:${right.principalId}`,
    );
  });

  return {
    members: paginate(memberRows, params?.offset, params?.limit),
    count: memberRows.length,
  };
};

export const handleSpaceMemberPut: Handler<"space.member.put"> = ({
  gw,
  params,
}) => {
  const spaceId = requireNonEmpty(params?.spaceId, "spaceId");
  const principalId = requireNonEmpty(params?.principalId, "principalId");
  const role = requireNonEmpty(params?.role, "role");

  const member = gw.registryStore.setMember(spaceId, principalId, role);
  return { ok: true, spaceId, principalId, member };
};

export const handleSpaceMemberRemove: Handler<"space.member.remove"> = ({
  gw,
  params,
}) => {
  const spaceId = requireNonEmpty(params?.spaceId, "spaceId");
  const principalId = requireNonEmpty(params?.principalId, "principalId");
  const removed = gw.registryStore.removeMember(spaceId, principalId);
  return { ok: true, spaceId, principalId, removed };
};

export const handleConversationBindingsList: Handler<"conversation.bindings.list"> = ({
  gw,
  params,
}) => {
  const entries = Object.entries(gw.registryStore.listConversationBindings())
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .map(([surfaceId, binding]) => ({ surfaceId, binding }));

  return {
    bindings: paginate(entries, params?.offset, params?.limit),
    count: entries.length,
  };
};

export const handleConversationBindingPut: Handler<"conversation.binding.put"> = ({
  gw,
  params,
}) => {
  const surfaceId = requireNonEmpty(params?.surfaceId, "surfaceId");
  const spaceId = requireNonEmpty(params?.spaceId, "spaceId");
  const agentId = normalizeOptionalId(params?.agentId);
  const groupMode = params?.groupMode;
  if (
    groupMode &&
    groupMode !== "group-shared" &&
    groupMode !== "per-user-in-group" &&
    groupMode !== "hybrid"
  ) {
    throw new RpcError(400, "groupMode must be group-shared, per-user-in-group, or hybrid");
  }

  const binding = gw.registryStore.upsertConversationBinding(
    normalizeId(surfaceId),
    {
      spaceId: normalizeId(spaceId),
      agentId,
      groupMode,
    },
  );

  return {
    ok: true,
    surfaceId: normalizeId(surfaceId),
    binding,
  };
};

export const handleConversationBindingRemove: Handler<"conversation.binding.remove"> = ({
  gw,
  params,
}) => {
  const surfaceId = requireNonEmpty(params?.surfaceId, "surfaceId");
  const normalizedSurfaceId = normalizeId(surfaceId);
  const removed = gw.registryStore.removeConversationBinding(normalizedSurfaceId);
  return { ok: true, surfaceId: normalizedSurfaceId, removed };
};

export const handleInviteCreate: Handler<"invite.create"> = ({
  gw,
  params,
}) => {
  const homeSpaceId = requireNonEmpty(params?.homeSpaceId, "homeSpaceId");
  const ttlMinutes = params?.ttlMinutes;
  if (
    ttlMinutes !== undefined &&
    (typeof ttlMinutes !== "number" || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0)
  ) {
    throw new RpcError(400, "ttlMinutes must be a positive number when provided");
  }

  try {
    const invite = createInvite(gw, {
      code: normalizeOptionalId(params?.code)?.toUpperCase(),
      homeSpaceId,
      homeAgentId: normalizeOptionalId(params?.homeAgentId),
      role: normalizeOptionalId(params?.role),
      principalId: normalizeOptionalId(params?.principalId),
      ttlMinutes,
    });
    return { ok: true, invite };
  } catch (error) {
    throw new RpcError(
      409,
      error instanceof Error ? error.message : "Failed to create invite",
    );
  }
};

export const handleInviteList: Handler<"invite.list"> = ({
  gw,
  params,
}) => {
  const includeInactive = params?.includeInactive === true;
  const invites = Object.entries(gw.registryStore.listInvites())
    .filter(([, invite]) => includeInactive || invite.status === "active")
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .map(([inviteId, invite]) => ({ inviteId, invite }));

  return {
    invites: paginate(invites, params?.offset, params?.limit),
    count: invites.length,
  };
};

export const handleInviteRevoke: Handler<"invite.revoke"> = ({
  gw,
  params,
}) => {
  const inviteId = requireNonEmpty(params?.inviteId, "inviteId");
  const invite = gw.registryStore.revokeInvite(inviteId);
  return {
    ok: true,
    inviteId,
    revoked: Boolean(invite),
    invite,
  };
};

export const handleInviteClaim: Handler<"invite.claim"> = ({
  gw,
  params,
}) => {
  const code = requireNonEmpty(params?.code, "code");
  const channel = normalizeOptionalId(params?.channel);
  const senderId = normalizeOptionalId(params?.senderId);
  const accountId = normalizeOptionalId(params?.accountId) ?? "default";
  const principalId = normalizeOptionalId(params?.principalId) ??
    (
      channel && senderId
        ? buildPrincipalIdFromChannel(channel, accountId, senderId)
        : undefined
    );
  if (!principalId) {
    throw new RpcError(
      400,
      "principalId required (or provide channel + senderId [+ accountId])",
    );
  }

  const claimed = claimInviteForPrincipal(gw, {
    code,
    principalId,
    channel,
    senderId,
  });
  if (!claimed.ok) {
    const statusCode = claimed.reason === "not-found" ? 404 : 409;
    throw new RpcError(statusCode, claimed.message);
  }

  return {
    ok: true,
    inviteId: claimed.invite.inviteId,
    code: claimed.invite.code,
    principalId: claimed.principalId,
    homeSpaceId: claimed.homeSpaceId,
    homeAgentId: claimed.homeAgentId,
    role: claimed.role,
  };
};

export const handlePendingBindingsList: Handler<"pending.bindings.list"> = ({
  gw,
}) => {
  const entries = Object.entries(gw.pendingPairs)
    .sort(([, left], [, right]) => right.requestedAt - left.requestedAt)
    .map(([key, pair]) => ({ key, pair }));

  return {
    pending: entries,
    count: entries.length,
  };
};

export const handlePendingBindingResolve: Handler<"pending.binding.resolve"> = ({
  gw,
  params,
}) => {
  const channel = requireNonEmpty(params?.channel, "channel");
  const senderId = requireNonEmpty(params?.senderId, "senderId");
  const action = params?.action;
  if (action !== "approve" && action !== "reject") {
    throw new RpcError(400, "action must be approve or reject");
  }

  const normalizedSender = normalizeId(normalizeE164(senderId) || senderId);
  const pairKey = `${channel}:${normalizedSender}`;
  const pending = gw.pendingPairs[pairKey];
  if (!pending) {
    throw new RpcError(404, `No pending binding for ${pairKey}`);
  }

  if (action === "reject") {
    delete gw.pendingPairs[pairKey];
    return {
      ok: true,
      action,
      senderId: normalizedSender,
    };
  }

  const config = gw.getFullConfig();
  const channelConfig = config.channels[channel];
  const currentAllowFrom = channelConfig?.allowFrom ?? [];
  if (!currentAllowFrom.includes(normalizedSender)) {
    gw.setConfigPath(`channels.${channel}.allowFrom`, [
      ...currentAllowFrom,
      normalizedSender,
    ]);
  }

  const accountId =
    normalizeOptionalId(params?.accountId) ??
    normalizeOptionalId(pending.accountId) ??
    "default";
  const principalId =
    normalizeOptionalId(params?.principalId) ??
    normalizeOptionalId(pending.principalId) ??
    buildPrincipalIdFromChannel(channel, accountId, normalizedSender);

  const peer: PeerInfo = {
    kind: "dm",
    id: normalizedSender,
  };

  const homeSpaceId = normalizeOptionalId(params?.homeSpaceId) ??
    resolveDefaultSpaceId(gw.getConfigPath("spaces.defaultSpaceId"));
  const fallbackAgentId = resolveAgentIdFromBinding(
    config,
    channel,
    accountId,
    peer,
  );
  const homeAgentId = normalizeOptionalId(params?.homeAgentId) ??
    normalizeOptionalId(fallbackAgentId);
  const role = normalizeOptionalId(params?.role) ?? "member";

  gw.registryStore.upsertPrincipalProfile(principalId, {
    homeSpaceId,
    homeAgentId,
    status: "bound",
  });
  gw.registryStore.setMember(homeSpaceId, principalId, role);

  delete gw.pendingPairs[pairKey];

  return {
    ok: true,
    action,
    senderId: normalizedSender,
    accountId,
    principalId,
    homeSpaceId,
    role,
  };
};

export const handleRegistryBackfill: Handler<"registry.backfill"> = ({
  gw,
  params,
}) => {
  return runRegistryBackfill(gw, {
    dryRun: params?.dryRun,
    limit: params?.limit,
  });
};

export const handleRegistryRepair: Handler<"registry.repair"> = ({
  gw,
  params,
}) => {
  return runRegistryRepair(gw, {
    dryRun: params?.dryRun,
    pruneDanglingRoutes: params?.pruneDanglingRoutes,
    pruneDanglingLegacyIndex: params?.pruneDanglingLegacyIndex,
  });
};
