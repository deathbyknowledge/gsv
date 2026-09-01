import type { KernelContext } from "../context";
import type { AuthTokenKind, AuthTokenRole } from "../auth-store";
import type {
  SysTokenCreateArgs,
  SysTokenCreateResult,
  SysTokenListArgs,
  SysTokenListResult,
  SysTokenRevokeArgs,
  SysTokenRevokeResult,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const ROLE_BY_KIND = {
  node: "driver",
  service: "service",
  user: "user",
} satisfies Record<AuthTokenKind, AuthTokenRole>;
const tokenWireSchema = z.unknown();
type TokenWireValue = z.input<typeof tokenWireSchema>;
const tokenCreateSchema = z.object({ uid: z.number().optional(), kind: z.string(), allowedRole: z.string().optional(), allowedDeviceId: z.string().optional(), label: z.string().optional(), expiresAt: z.number().optional() });
const tokenListSchema = z.object({ uid: z.number().optional() });
const tokenRevokeSchema = z.object({ uid: z.number().optional(), tokenId: z.string().optional(), reason: z.string().optional() });

function requireUid(ctx: KernelContext): number {
  const uid = ctx.identity?.process.uid;
  if (uid === undefined) {
    throw new Error("Authentication required");
  }
  return uid;
}

function parseOptionalUid(input: TokenWireValue): number | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = z.number().int().nonnegative().safeParse(input);
  if (!parsed.success) {
    throw new Error("uid must be a non-negative integer");
  }
  return parsed.data;
}

function parseTokenKind(input: TokenWireValue): AuthTokenKind {
  const parsed = z.enum(["node", "service", "user"]).safeParse(input);
  if (!parsed.success) {
    throw new Error("kind must be one of: node, service, user");
  }
  return parsed.data;
}

function parseTokenRole(input: TokenWireValue): AuthTokenRole {
  const parsed = z.enum(["driver", "service", "user"]).safeParse(input);
  if (!parsed.success) {
    throw new Error("allowedRole must be one of: driver, service, user");
  }
  return parsed.data;
}

function parseOptionalString(input: TokenWireValue): string | undefined {
  const parsed = z.string().safeParse(input);
  if (!parsed.success) return undefined;
  const trimmed = parsed.data.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalFutureTimestamp(input: TokenWireValue): number | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = z.number().finite().safeParse(input);
  if (!parsed.success) {
    throw new Error("expiresAt must be a unix timestamp in milliseconds");
  }
  const value = Math.floor(parsed.data);
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

  const raw = tokenCreateSchema.parse(args);
  const targetUid = parseOptionalUid(raw.uid) ?? callerUid;
  if (!isRoot && targetUid !== callerUid) {
    throw new Error("Permission denied: cannot create tokens for another user");
  }

  const kind = parseTokenKind(raw.kind);
  if (kind === "service" && !isRoot) {
    throw new Error("Permission denied: only root may create service tokens");
  }
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
  if (allowedRole === "driver" && !allowedDeviceId) {
    throw new Error("allowedDeviceId is required for driver-bound tokens");
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
  const raw = tokenListSchema.parse(args);

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
  const raw = tokenRevokeSchema.parse(args);

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
