import type {
  AiToolsTarget,
  SysTargetDetail,
  SysTargetSummary,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { KernelContext } from "./context";
import { principalOf } from "./context";
import type { TargetRecord } from "./target-registry";
import {
  listVisibleAdapterTargets,
  type AdapterTargetRoute,
} from "./adapter-targets";

export const GSV_TARGET_ID = "gsv";
export const GSV_TARGET_IMPLEMENTATIONS = ["fs.*", "shell.exec", "net.fetch"] as const;

export type TargetDescriptor = {
  targetId: string;
  ownerUid: number;
  ownerUsername: string | null;
  label: string;
  description: string;
  platform: string;
  version: string;
  online: boolean;
  implements: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
  route: { kind: "machine"; targetId: string } | AdapterTargetRoute;
};

export type TargetListOptions = {
  includeOffline?: boolean;
};

type TargetMetadataPatch = {
  label?: string;
  description?: string;
};

export function listVisibleTargets(
  ctx: KernelContext,
  options: TargetListOptions = {},
): TargetDescriptor[] {
  const identity = principalOf(ctx)?.account;
  if (!identity) {
    return [];
  }

  return ctx.targets
    .listForUser(identity.uid, identity.gids)
    .filter((device) => options.includeOffline || device.online)
    .map((device) => targetRecordToDescriptor(ctx, device));
}

export async function listAllVisibleTargets(
  ctx: KernelContext,
  options: TargetListOptions = {},
): Promise<TargetDescriptor[]> {
  const adapterTargets = await listVisibleAdapterTargets(ctx, options);
  return [...listVisibleTargets(ctx, options), ...adapterTargets];
}

export function getVisibleTarget(
  ctx: KernelContext,
  targetId: string,
  options: TargetListOptions = {},
): TargetDescriptor | null {
  const identity = principalOf(ctx)?.account;
  if (!identity || !ctx.targets.canAccess(targetId, identity.uid, identity.gids)) {
    return null;
  }

  const device = ctx.targets.get(targetId);
  if (!device || (!options.includeOffline && !device.online)) {
    return null;
  }

  return targetRecordToDescriptor(ctx, device);
}

export async function resolveVisibleTarget(
  ctx: KernelContext,
  targetId: string,
  options: TargetListOptions = {},
): Promise<TargetDescriptor | null> {
  return getVisibleTarget(ctx, targetId, options)
    ?? (await listVisibleAdapterTargets(ctx, options)).find(
      (target) => target.targetId === targetId,
    )
    ?? null;
}

export function updateTargetMetadata(
  ctx: KernelContext,
  targetId: string,
  patch: TargetMetadataPatch,
): TargetDescriptor | null {
  const identity = principalOf(ctx)?.account;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const target = getVisibleTarget(ctx, targetId, { includeOffline: true });
  if (!target) {
    return null;
  }
  if (identity.uid !== 0 && target.ownerUid !== identity.uid) {
    throw new Error("Permission denied: device metadata is owner-managed");
  }

  ctx.targets.setMetadata(target.targetId, patch);
  const device = ctx.targets.get(target.targetId);
  return device ? targetRecordToDescriptor(ctx, device) : null;
}

export function targetCanHandle(target: TargetDescriptor, syscall: string): boolean {
  return hasCapability(target.implements, syscall);
}

export function targetToAiTarget(target: TargetDescriptor): AiToolsTarget {
  const device: AiToolsTarget = {
    id: target.targetId,
    implements: target.implements,
    label: target.label,
    platform: target.platform || undefined,
  };
  if (target.description) {
    device.description = target.description;
  }
  return device;
}

export function targetToSummary(target: TargetDescriptor): SysTargetSummary {
  return {
    targetId: target.targetId,
    ownerUid: target.ownerUid,
    ownerUsername: target.ownerUsername,
    label: target.label,
    description: target.description,
    implements: target.implements,
    platform: target.platform,
    version: target.version,
    online: target.online,
    lastSeenAt: target.lastSeenAt,
  };
}

export function targetToDetail(target: TargetDescriptor): SysTargetDetail {
  return {
    ...targetToSummary(target),
    firstSeenAt: target.firstSeenAt,
    connectedAt: target.connectedAt,
    disconnectedAt: target.disconnectedAt,
  };
}

function targetRecordToDescriptor(ctx: KernelContext, record: TargetRecord): TargetDescriptor {
  return {
    targetId: record.target_id,
    ownerUid: record.owner_uid,
    ownerUsername: ctx.auth.getPasswdByUid(record.owner_uid)?.username ?? null,
    label: record.label,
    description: record.description,
    platform: record.platform,
    version: record.version,
    online: record.online,
    implements: record.implements,
    firstSeenAt: record.first_seen_at,
    lastSeenAt: record.last_seen_at,
    connectedAt: record.connected_at,
    disconnectedAt: record.disconnected_at,
    route: { kind: "machine", targetId: record.target_id },
  };
}
