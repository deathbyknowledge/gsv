import type { KernelContext } from "../context";
import type {
  SysTargetListArgs,
  SysTargetListResult,
  SysTargetGetArgs,
  SysTargetGetResult,
  SysTargetDeleteArgs,
  SysTargetDeleteResult,
  SysTargetUpdateArgs,
  SysTargetUpdateResult,
} from "@humansandmachines/gsv/protocol";
import {
  getVisibleTarget,
  listVisibleTargets,
  targetToDetail,
  targetToSummary,
  updateTargetMetadata,
} from "../targets";
import { z } from "zod";

const targetArgsSchema = z.object({
  includeOffline: z.boolean().optional(),
  targetId: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});
type TargetMetadata = { label?: string; description?: string };

export function handleSysTargetList(
  args: SysTargetListArgs,
  ctx: KernelContext,
): SysTargetListResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = targetArgsSchema.parse(args ?? {});
  const includeOffline = raw.includeOffline === true;

  return {
    targets: listVisibleTargets(ctx, { includeOffline }).map(targetToSummary),
  };
}

export function handleSysTargetGet(
  args: SysTargetGetArgs,
  ctx: KernelContext,
): SysTargetGetResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = targetArgsSchema.parse(args ?? {});
  const targetId = raw.targetId?.trim() ?? "";
  if (!targetId) {
    throw new Error("sys.target.get requires targetId");
  }

  const target = getVisibleTarget(ctx, targetId, { includeOffline: true });

  return {
    target: target ? targetToDetail(target) : null,
  };
}

export function handleSysTargetUpdate(
  args: SysTargetUpdateArgs,
  ctx: KernelContext,
): SysTargetUpdateResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = targetArgsSchema.parse(args ?? {});
  const targetId = raw.targetId?.trim() ?? "";
  if (!targetId) {
    throw new Error("sys.target.update requires targetId");
  }

  const target = getVisibleTarget(ctx, targetId, { includeOffline: true });
  if (!target) {
    return { target: null };
  }
  if (raw.label === undefined && raw.description === undefined) {
    throw new Error("sys.target.update requires label or description");
  }

  const metadata: TargetMetadata = {};
  if (raw.label !== undefined) metadata.label = raw.label;
  if (raw.description !== undefined) metadata.description = raw.description;
  const updated = updateTargetMetadata(ctx, targetId, metadata);
  return {
    target: updated ? targetToDetail(updated) : null,
  };
}

export function handleSysTargetDelete(
  args: SysTargetDeleteArgs,
  ctx: KernelContext,
): SysTargetDeleteResult {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = targetArgsSchema.parse(args ?? {});
  const targetId = raw.targetId?.trim() ?? "";
  if (!targetId) {
    throw new Error("sys.target.delete requires targetId");
  }

  const device = ctx.targets.get(targetId);
  if (!device || !ctx.targets.canAccess(targetId, identity.uid, identity.gids)) {
    return { deleted: false, targetId: targetId, revokedTokens: 0 };
  }
  if (identity.uid !== 0 && device.owner_uid !== identity.uid) {
    throw new Error("Permission denied: machine forgetting is owner-managed");
  }

  const revokedTokens = ctx.auth
    .listTokens(identity.uid === 0 ? undefined : identity.uid)
    .filter((token) =>
      token.kind === "machine" &&
      token.peerId === targetId &&
      token.revokedAt === null
    )
    .reduce((count, token) => (
      ctx.auth.revokeToken(token.tokenId, "machine forgotten", identity.uid === 0 ? undefined : identity.uid)
        ? count + 1
        : count
    ), 0);

  return {
    deleted: ctx.targets.remove(targetId),
    targetId: targetId,
    revokedTokens,
  };
}
