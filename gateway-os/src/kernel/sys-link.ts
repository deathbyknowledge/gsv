import type { KernelContext } from "./context";
import type {
  UserIdentity,
  SysLinkArgs,
  SysLinkConsumeArgs,
  SysLinkConsumeResult,
  SysLinkListArgs,
  SysLinkListResult,
  SysLinkResult,
  SysUnlinkArgs,
  SysUnlinkResult,
} from "../syscalls/system";

export function handleSysLinkConsume(
  args: SysLinkConsumeArgs,
  ctx: KernelContext,
): SysLinkConsumeResult {
  const identity = requireUserIdentity(ctx);

  const code = typeof args.code === "string" ? args.code.trim().toUpperCase() : "";
  if (!code) {
    throw new Error("code is required");
  }

  const challenge = ctx.adapters.linkChallenges.consume(code, identity.process.uid);
  if (!challenge) {
    throw new Error("Invalid or expired link code");
  }

  const link = ctx.adapters.identityLinks.link(
    challenge.adapter,
    challenge.accountId,
    challenge.actorId,
    identity.process.uid,
    identity.process.uid,
    { code: challenge.code, surfaceKind: challenge.surfaceKind, surfaceId: challenge.surfaceId },
  );

  return {
    linked: true,
    link: {
      adapter: link.adapter,
      accountId: link.accountId,
      actorId: link.actorId,
      uid: link.uid,
      createdAt: link.createdAt,
    },
  };
}

export function handleSysLink(
  args: SysLinkArgs,
  ctx: KernelContext,
): SysLinkResult {
  const identity = requireUserIdentity(ctx);

  const adapter = normalizeRequired(args.adapter, "adapter");
  const accountId = normalizeRequired(args.accountId, "accountId");
  const actorId = normalizeRequired(args.actorId, "actorId");
  const targetUid = resolveTargetUid(identity, args.uid);

  const link = ctx.adapters.identityLinks.link(
    adapter,
    accountId,
    actorId,
    targetUid,
    identity.process.uid,
  );

  return {
    linked: true,
    link: {
      adapter: link.adapter,
      accountId: link.accountId,
      actorId: link.actorId,
      uid: link.uid,
      createdAt: link.createdAt,
    },
  };
}

export function handleSysUnlink(
  args: SysUnlinkArgs,
  ctx: KernelContext,
): SysUnlinkResult {
  const identity = requireUserIdentity(ctx);

  const adapter = normalizeRequired(args.adapter, "adapter");
  const accountId = normalizeRequired(args.accountId, "accountId");
  const actorId = normalizeRequired(args.actorId, "actorId");

  const existing = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
  if (!existing) {
    return { removed: false };
  }

  if (identity.process.uid !== 0 && existing.uid !== identity.process.uid) {
    throw new Error("Permission denied");
  }

  return {
    removed: ctx.adapters.identityLinks.unlink(adapter, accountId, actorId),
  };
}

export function handleSysLinkList(
  args: SysLinkListArgs,
  ctx: KernelContext,
): SysLinkListResult {
  const identity = requireUserIdentity(ctx);

  let uidFilter: number | undefined;
  if (typeof args.uid === "number") {
    if (identity.process.uid !== 0 && args.uid !== identity.process.uid) {
      throw new Error("Permission denied");
    }
    uidFilter = args.uid;
  } else if (identity.process.uid !== 0) {
    uidFilter = identity.process.uid;
  }

  const links = ctx.adapters.identityLinks.list(uidFilter).map((link) => ({
    adapter: link.adapter,
    accountId: link.accountId,
    actorId: link.actorId,
    uid: link.uid,
    createdAt: link.createdAt,
    linkedByUid: link.linkedByUid,
  }));

  return { links };
}

function requireUserIdentity(ctx: KernelContext): UserIdentity {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error("Authentication required");
  }
  return identity;
}

function resolveTargetUid(identity: UserIdentity, requestedUid: number | undefined): number {
  if (typeof requestedUid !== "number") {
    return identity.process.uid;
  }
  if (requestedUid === identity.process.uid) {
    return requestedUid;
  }
  if (identity.process.uid === 0) {
    return requestedUid;
  }
  throw new Error("Permission denied");
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return field === "adapter" ? normalized.toLowerCase() : normalized;
}
