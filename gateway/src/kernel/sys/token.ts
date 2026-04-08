import type { KernelContext } from "../context";
import type { AuthTokenKind, AuthTokenRole } from "../auth-store";
import type {
  SysTokenCreateArgs,
  SysTokenCreateResult,
  SysTokenListArgs,
  SysTokenListResult,
  SysTokenRevokeArgs,
  SysTokenRevokeResult,
} from "../../syscalls/system";

const TOKEN_KINDS = new Set<AuthTokenKind>(["node", "service", "user"]);
const TOKEN_ROLES = new Set<AuthTokenRole>(["driver", "service", "user"]);

const ROLE_BY_KIND: Record<AuthTokenKind, AuthTokenRole> = {
  node: "driver",
  service: "service",
  user: "user",
};

function requireUid(ctx: KernelContext): number {
  const uid = ctx.identity?.process.uid;
  if (typeof uid !== "number") {
    throw new Error("Authentication required");
  }
  return uid;
}

function parseOptionalUid(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Number.isInteger(input) || typeof input !== "number" || input < 0) {
    throw new Error("uid must be a non-negative integer");
  }
  return input;
}

function parseTokenKind(input: unknown): AuthTokenKind {
  if (typeof input !== "string" || !TOKEN_KINDS.has(input as AuthTokenKind)) {
    throw new Error("kind must be one of: node, service, user");
  }
  return input as AuthTokenKind;
}

function parseTokenRole(input: unknown): AuthTokenRole {
  if (typeof input !== "string" || !TOKEN_ROLES.has(input as AuthTokenRole)) {
    throw new Error("allowedRole must be one of: driver, service, user");
  }
  return input as AuthTokenRole;
}

function parseOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalFutureTimestamp(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error("expiresAt must be a unix timestamp in milliseconds");
  }
  const value = Math.floor(input);
  if (value <= Date.now()) {
    throw new Error("expiresAt must be in the future");
  }
  return value;
}

export async function handleSysTokenCreate(
  args: SysTokenCreateArgs,
  ctx: KernelContext,
): Promise<SysTokenCreateResult> {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;

  const raw = args as Record<string, unknown>;
  const targetUid = parseOptionalUid(raw.uid) ?? callerUid;
  if (!isRoot && targetUid !== callerUid) {
    throw new Error("Permission denied: cannot create tokens for another user");
  }

  const kind = parseTokenKind(raw.kind);
  const defaultRole = ROLE_BY_KIND[kind];
  const allowedRole = raw.allowedRole === undefined
    ? defaultRole
    : parseTokenRole(raw.allowedRole);
  if (allowedRole !== defaultRole) {
    throw new Error(`Invalid allowedRole for kind=${kind}: expected ${defaultRole}`);
  }

  const allowedDeviceId = parseOptionalString(raw.allowedDeviceId);
  if (allowedDeviceId && allowedRole !== "driver") {
    throw new Error("allowedDeviceId is only valid for driver-bound tokens");
  }

  const issued = await ctx.auth.issueToken({
    uid: targetUid,
    kind,
    label: parseOptionalString(raw.label),
    allowedRole,
    allowedDeviceId,
    expiresAt: parseOptionalFutureTimestamp(raw.expiresAt),
  });

  return { token: issued };
}

export function handleSysTokenList(
  args: SysTokenListArgs,
  ctx: KernelContext,
): SysTokenListResult {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;

  const requestedUid = parseOptionalUid(raw.uid);
  if (!isRoot && requestedUid !== undefined && requestedUid !== callerUid) {
    throw new Error("Permission denied: cannot list tokens for another user");
  }

  const effectiveUid = isRoot ? requestedUid : callerUid;
  return { tokens: ctx.auth.listTokens(effectiveUid) };
}

export function handleSysTokenRevoke(
  args: SysTokenRevokeArgs,
  ctx: KernelContext,
): SysTokenRevokeResult {
  const callerUid = requireUid(ctx);
  const isRoot = callerUid === 0;
  const raw = args as Record<string, unknown>;

  const tokenId = parseOptionalString(raw.tokenId);
  if (!tokenId) {
    throw new Error("sys.token.revoke requires tokenId");
  }

  const requestedUid = parseOptionalUid(raw.uid);
  if (!isRoot && requestedUid !== undefined && requestedUid !== callerUid) {
    throw new Error("Permission denied: cannot revoke tokens for another user");
  }

  const effectiveUid = isRoot ? requestedUid : callerUid;
  const revoked = ctx.auth.revokeToken(
    tokenId,
    parseOptionalString(raw.reason),
    effectiveUid,
  );
  return { revoked };
}
