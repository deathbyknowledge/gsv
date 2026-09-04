import type { KernelContext, PrincipalView } from "../context";
import { principalOf } from "../context";
import type {
  SysLinkArgs,
  SysLinkConsumeArgs,
  SysLinkConsumeResult,
  SysLinkListArgs,
  SysLinkListResult,
  SysLinkResult,
  SysUnlinkArgs,
  SysUnlinkResult,
} from "@humansandmachines/gsv/protocol";

export function handleSysLinkConsume(
  args: SysLinkConsumeArgs,
  ctx: KernelContext,
): SysLinkConsumeResult {
  const identity = requirePrincipalView(ctx);

  const code = args.code.trim().toUpperCase();
  if (!code) {
    throw new Error("code is required");
  }

  const challenge = ctx.adapters.linkChallenges.consume(code, identity.account.uid);
  if (!challenge) {
    throw new Error("Invalid or expired link code");
  }

  const link = ctx.adapters.identityLinks.link(
    challenge.adapter,
    challenge.accountId,
    challenge.actorId,
    identity.account.uid,
    identity.account.uid,
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
  const identity = requirePrincipalView(ctx);
  if (identity.account.uid !== 0) {
    throw new Error("Permission denied: manual links require root");
  }

  const adapter = normalizeRequired(args.adapter, "adapter");
  const accountId = normalizeRequired(args.accountId, "accountId");
  const actorId = normalizeRequired(args.actorId, "actorId");
  const targetUid = resolveTargetUid(identity, args.uid);

  const link = ctx.adapters.identityLinks.link(
    adapter,
    accountId,
    actorId,
    targetUid,
    identity.account.uid,
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
  const identity = requirePrincipalView(ctx);

  const adapter = normalizeRequired(args.adapter, "adapter");
  const accountId = normalizeRequired(args.accountId, "accountId");
  const actorId = normalizeRequired(args.actorId, "actorId");

  const existing = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
  if (!existing) {
    return { removed: false };
  }

  if (existing.metadata?.managed === true) {
    throw new Error("Managed adapter identities must be disconnected through adapter pairing");
  }

  if (identity.account.uid !== 0 && existing.uid !== identity.account.uid) {
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
  const identity = requirePrincipalView(ctx);

  let uidFilter: number | undefined;
  if (args.uid !== undefined) {
    if (identity.account.uid !== 0 && args.uid !== identity.account.uid) {
      throw new Error("Permission denied");
    }
    uidFilter = args.uid;
  } else if (identity.account.uid !== 0) {
    uidFilter = identity.account.uid;
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

function requirePrincipalView(ctx: KernelContext): PrincipalView {
  const identity = principalOf(ctx);
  if (!identity || identity.kind !== "human") {
    throw new Error("Authentication required");
  }
  return identity;
}

function resolveTargetUid(identity: PrincipalView, requestedUid: number | undefined): number {
  if (requestedUid === undefined) {
    return identity.account.uid;
  }
  if (requestedUid === identity.account.uid) {
    return requestedUid;
  }
  if (identity.account.uid === 0) {
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
