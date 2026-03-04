import { NATIVE_TOOLS } from "../agents/tools/constants";
import { TRANSFER_TOOL_NAME } from "../agents/tools/transfer";
import type { Gateway } from "./do";

export type PolicyCapability =
  | "workspace.read"
  | "workspace.write"
  | "workspace.delete"
  | "config.read"
  | "config.write"
  | "cron.manage"
  | "delivery.reply"
  | "message.send"
  | "sessions.read"
  | "sessions.write"
  | "threads.read"
  | "node.logs.read"
  | "node.exec"
  | "transfer.execute"
  | (string & {});

export type AuthorizationResult = {
  ok: boolean;
  capability?: PolicyCapability;
  reason?: string;
  sessionKey?: string;
  spaceId?: string;
  targetSpaceId?: string;
  principalId?: string;
  role?: string;
};

export type SessionPolicyContext = {
  sessionKey?: string;
  spaceId?: string;
  principalId?: string;
  role?: string;
  isOwner: boolean;
};

const TOOL_CAPABILITY_MAP: Record<string, PolicyCapability> = {
  [NATIVE_TOOLS.READ_FILE]: "workspace.read",
  [NATIVE_TOOLS.WRITE_FILE]: "workspace.write",
  [NATIVE_TOOLS.EDIT_FILE]: "workspace.write",
  [NATIVE_TOOLS.DELETE_FILE]: "workspace.delete",
  [NATIVE_TOOLS.CONFIG_GET]: "config.read",
  [NATIVE_TOOLS.LOGS_GET]: "node.logs.read",
  [NATIVE_TOOLS.CRON]: "cron.manage",
  [NATIVE_TOOLS.MESSAGE]: "message.send",
  [NATIVE_TOOLS.SESSIONS_LIST]: "sessions.read",
  [NATIVE_TOOLS.SESSION_SEND]: "sessions.write",
  [TRANSFER_TOOL_NAME]: "transfer.execute",
};

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCapability(value: string): PolicyCapability {
  return normalizeId(value) as PolicyCapability;
}

function normalizeOptionalId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeId(trimmed);
}

function normalizeOptionalSessionRef(
  value: string | undefined | null,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asCapabilitySet(value: unknown): Set<PolicyCapability> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = new Set<PolicyCapability>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = normalizeCapability(item);
    if (!normalized) {
      continue;
    }
    result.add(normalized);
  }
  return result;
}

function matchesCapability(
  set: Set<PolicyCapability> | undefined,
  capability: PolicyCapability,
): boolean {
  if (!set) {
    return false;
  }
  return set.has("*") || set.has(capability);
}

function resolveSessionEntry(
  gw: Gateway,
  sessionKey: string | undefined,
): {
  sessionKey?: string;
  spaceId?: string;
  principalId?: string;
} {
  const normalizedSessionKey = normalizeOptionalSessionRef(sessionKey);
  if (!normalizedSessionKey) {
    return {};
  }

  const entry = gw.sessionRegistry[normalizedSessionKey];
  if (!entry) {
    return { sessionKey: normalizedSessionKey };
  }

  const threadSpaceId = entry.threadId
    ? normalizeOptionalId(gw.registryStore.getThreadMeta(entry.threadId)?.spaceId)
    : undefined;

  return {
    sessionKey: normalizedSessionKey,
    spaceId: normalizeOptionalId(entry.spaceId) ?? threadSpaceId,
    principalId: normalizeOptionalId(entry.principalId),
  };
}

export function resolveSessionPolicyContext(params: {
  gw: Gateway;
  sessionKey?: string;
  fallbackSpaceId?: string;
}): SessionPolicyContext {
  const session = resolveSessionEntry(params.gw, params.sessionKey);
  const spaceId = normalizeOptionalId(params.fallbackSpaceId) ?? session.spaceId;
  const principalId = session.principalId;
  const isOwner = principalId ? params.gw.registryStore.isOwner(principalId) : false;
  const membership = principalId && spaceId
    ? params.gw.registryStore.getSpaceMembers(spaceId)[principalId]
    : undefined;
  const role = normalizeOptionalId(membership?.role) ?? (isOwner ? "owner" : undefined);

  return {
    sessionKey: session.sessionKey,
    spaceId,
    principalId,
    role,
    isOwner,
  };
}

export function authorizeCrossSpaceSessionOperation(params: {
  gw: Gateway;
  operation: string;
  sourceSessionKey?: string;
  sourceSpaceId?: string;
  targetSessionKey?: string;
  targetThreadId?: string;
  targetSpaceId?: string;
}): AuthorizationResult {
  const source = resolveSessionPolicyContext({
    gw: params.gw,
    sessionKey: params.sourceSessionKey,
    fallbackSpaceId: params.sourceSpaceId,
  });

  let targetSpaceId = normalizeOptionalId(params.targetSpaceId);
  const normalizedTargetThreadId = normalizeOptionalSessionRef(params.targetThreadId);
  if (!targetSpaceId && normalizedTargetThreadId) {
    targetSpaceId = normalizeOptionalId(
      params.gw.registryStore.getThreadMeta(normalizedTargetThreadId)?.spaceId,
    );
  }
  if (!targetSpaceId) {
    targetSpaceId = resolveSessionPolicyContext({
      gw: params.gw,
      sessionKey: params.targetSessionKey,
    }).spaceId;
  }

  if (
    source.spaceId &&
    targetSpaceId &&
    source.spaceId !== targetSpaceId &&
    !source.isOwner
  ) {
    return {
      ok: false,
      reason:
        `cross-space ${params.operation} denied: ` +
        `source space '${source.spaceId}' cannot access target space '${targetSpaceId}'`,
      sessionKey: source.sessionKey,
      spaceId: source.spaceId,
      targetSpaceId,
      principalId: source.principalId,
      role: source.role,
    };
  }

  return {
    ok: true,
    sessionKey: source.sessionKey,
    spaceId: source.spaceId,
    targetSpaceId,
    principalId: source.principalId,
    role: source.role,
  };
}

export function resolveCapabilityForToolName(
  toolName: string,
): PolicyCapability | undefined {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    return undefined;
  }
  if (TOOL_CAPABILITY_MAP[normalizedToolName]) {
    return TOOL_CAPABILITY_MAP[normalizedToolName];
  }
  // Non-native tools are node-routed tools.
  if (!normalizedToolName.startsWith("gsv__")) {
    return "node.exec";
  }
  return undefined;
}

export function authorizeSessionCapability(params: {
  gw: Gateway;
  sessionKey?: string;
  capability: PolicyCapability;
}): AuthorizationResult {
  const { gw } = params;
  const capability = normalizeCapability(params.capability);
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return { ok: true, capability };
  }

  const session = gw.sessionRegistry[sessionKey];
  if (!session) {
    return { ok: true, capability, sessionKey };
  }

  const spaceId = session.spaceId ? normalizeId(session.spaceId) : undefined;
  if (!spaceId) {
    return { ok: true, capability, sessionKey };
  }

  const principalId = session.principalId
    ? normalizeId(session.principalId)
    : undefined;
  const isOwner = principalId ? gw.registryStore.isOwner(principalId) : false;
  const membership = principalId
    ? gw.registryStore.getSpaceMembers(spaceId)[principalId]
    : undefined;
  const role = normalizeId(membership?.role ?? (isOwner ? "owner" : "member"));

  const roleAllow = asCapabilitySet(
    gw.getConfigPath(`roles.${role}.allowCapabilities`),
  );
  const roleDeny = asCapabilitySet(
    gw.getConfigPath(`roles.${role}.denyCapabilities`),
  );
  const spaceAllow = asCapabilitySet(
    gw.getConfigPath(`spaces.entries.${spaceId}.policy.allowCapabilities`),
  );
  const spaceDeny = asCapabilitySet(
    gw.getConfigPath(`spaces.entries.${spaceId}.policy.denyCapabilities`),
  );

  const hasRolePolicy = roleAllow !== undefined || roleDeny !== undefined;
  const hasSpacePolicy = spaceAllow !== undefined || spaceDeny !== undefined;

  // Compatibility: if no role/space policy exists, keep existing behavior.
  if (!hasRolePolicy && !hasSpacePolicy) {
    return {
      ok: true,
      capability,
      sessionKey,
      spaceId,
      principalId,
      role,
    };
  }

  if (matchesCapability(roleDeny, capability)) {
    return {
      ok: false,
      capability,
      sessionKey,
      spaceId,
      principalId,
      role,
      reason: `capability denied by role policy (${role}): ${capability}`,
    };
  }
  if (matchesCapability(spaceDeny, capability)) {
    return {
      ok: false,
      capability,
      sessionKey,
      spaceId,
      principalId,
      role,
      reason: `capability denied by space policy (${spaceId}): ${capability}`,
    };
  }

  if (hasRolePolicy && !matchesCapability(roleAllow, capability)) {
    return {
      ok: false,
      capability,
      sessionKey,
      spaceId,
      principalId,
      role,
      reason: `capability not allowed by role policy (${role}): ${capability}`,
    };
  }
  if (hasSpacePolicy && !matchesCapability(spaceAllow, capability)) {
    return {
      ok: false,
      capability,
      sessionKey,
      spaceId,
      principalId,
      role,
      reason: `capability not allowed by space policy (${spaceId}): ${capability}`,
    };
  }

  return {
    ok: true,
    capability,
    sessionKey,
    spaceId,
    principalId,
    role,
  };
}

export function authorizeSessionTool(params: {
  gw: Gateway;
  sessionKey?: string;
  toolName: string;
}): AuthorizationResult {
  const requiredCapability = resolveCapabilityForToolName(params.toolName);
  if (!requiredCapability) {
    return { ok: true };
  }

  return authorizeSessionCapability({
    gw: params.gw,
    sessionKey: params.sessionKey,
    capability: requiredCapability,
  });
}
