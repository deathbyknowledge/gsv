import type {
  AiToolsTarget,
  SysTargetDetail,
  SysTargetSummary,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { KernelContext } from "./context";
import { principalOf } from "./context";
import type { TargetRecord } from "./target-registry";
import type { ProcessApprovalTarget } from "../protocol/process-frames";
import { discoverInstanceTargets, type InstanceTargetRoute } from "./instance-targets";
import {
  discoverVisibleAdapterTargets,
  type AdapterTargetRoute,
} from "./adapter-targets";

export const GSV_TARGET_ID = "gsv";
export const GSV_TARGET_IMPLEMENTATIONS = ["fs.*", "shell.exec", "net.fetch"] as const;

export function gsvTargetImplementations(ctx: Pick<KernelContext, "env">): string[] {
  return ctx.env.WEB_SEARCH
    ? [...GSV_TARGET_IMPLEMENTATIONS, "web.search"]
    : [...GSV_TARGET_IMPLEMENTATIONS];
}

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
  instance?: SysTargetSummary["instance"];
  route: { kind: "machine"; targetId: string } | AdapterTargetRoute | InstanceTargetRoute;
};

export function approvalTargetIdentity(target: TargetDescriptor): ProcessApprovalTarget {
  const { targetId, ownerUid, platform, route } = target;
  return { targetId, ownerUid, platform, route };
}

export function matchesApprovalTarget(target: TargetDescriptor, approved: ProcessApprovalTarget): boolean {
  if (target.targetId !== approved.targetId || target.ownerUid !== approved.ownerUid || target.platform !== approved.platform) return false;
  const actual = target.route;
  const expected = approved.route;
  switch (actual.kind) {
    case "machine":
      return expected.kind === "machine" && actual.targetId === expected.targetId;
    case "instance":
      return expected.kind === "instance" && actual.instanceId === expected.instanceId;
    case "adapter":
      return expected.kind === "adapter" && actual.adapter === expected.adapter
        && actual.accountId === expected.accountId && actual.actorId === expected.actorId
        && actual.adapterTargetId === expected.adapterTargetId && actual.routeGeneration === expected.routeGeneration;
  }
}

export type TargetListOptions = {
  includeOffline?: boolean;
};

export type TargetDiscovery = {
  targets: TargetDescriptor[];
  complete: boolean;
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
  return (await discoverVisibleTargets(ctx, options)).targets;
}

export async function discoverVisibleTargets(
  ctx: KernelContext,
  options: TargetListOptions = {},
): Promise<TargetDiscovery> {
  const [discovery, instances] = await Promise.all([discoverVisibleAdapterTargets(ctx, options), discoverInstanceTargets(ctx, options)]);
  return {
    targets: [...listVisibleTargets(ctx, options), ...discovery.targets, ...instances.targets],
    complete: discovery.complete && instances.complete,
  };
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
  const local = getVisibleTarget(ctx, targetId, options);
  if (local) return local;
  const [adapters, instances] = await Promise.all([discoverVisibleAdapterTargets(ctx, options), discoverInstanceTargets(ctx, options)]);
  return [...adapters.targets, ...instances.targets].find(target => target.targetId === targetId) ?? null;
}

export async function resolveSelectedMessageTarget(ctx: KernelContext, targetId: string | undefined): Promise<string | undefined> {
  if (targetId === undefined || targetId === GSV_TARGET_ID) return targetId;
  const target = await resolveVisibleTarget(ctx, targetId, { includeOffline: true });
  if (!target) throw new Error(`Selected target is unavailable: ${targetId}`);
  return target.targetId;
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
    instance: target.instance,
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
