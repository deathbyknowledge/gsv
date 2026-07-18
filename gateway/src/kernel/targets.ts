import type {
  AiToolsDevice,
  SysDeviceDetail,
  SysDeviceSummary,
} from "@humansandmachines/gsv/protocol";
import { hasCapability } from "./capabilities";
import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";

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
  const identity = ctx.identity?.process;
  if (!identity) {
    return [];
  }

  return ctx.devices
    .listForUser(identity.uid, identity.gids)
    .filter((device) => options.includeOffline || device.online)
    .map((device) => deviceRecordToTarget(ctx, device));
}

export function getVisibleTarget(
  ctx: KernelContext,
  targetId: string,
  options: TargetListOptions = {},
): TargetDescriptor | null {
  const identity = ctx.identity?.process;
  if (!identity || !ctx.devices.canAccess(targetId, identity.uid, identity.gids)) {
    return null;
  }

  const device = ctx.devices.get(targetId);
  if (!device || (!options.includeOffline && !device.online)) {
    return null;
  }

  return deviceRecordToTarget(ctx, device);
}

export function updateTargetMetadata(
  ctx: KernelContext,
  targetId: string,
  patch: TargetMetadataPatch,
): TargetDescriptor | null {
  const identity = ctx.identity?.process;
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

  ctx.devices.setMetadata(target.targetId, patch);
  const device = ctx.devices.get(target.targetId);
  return device ? deviceRecordToTarget(ctx, device) : null;
}

export function targetCanHandle(target: TargetDescriptor, syscall: string): boolean {
  return hasCapability(target.implements, syscall);
}

export function targetToAiDevice(target: TargetDescriptor): AiToolsDevice {
  return {
    id: target.targetId,
    implements: target.implements,
    label: target.label,
    ...(target.description ? { description: target.description } : {}),
    platform: target.platform || undefined,
  };
}

export function targetToDeviceSummary(target: TargetDescriptor): SysDeviceSummary {
  return {
    deviceId: target.targetId,
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

export function targetToDeviceDetail(target: TargetDescriptor): SysDeviceDetail {
  return {
    ...targetToDeviceSummary(target),
    firstSeenAt: target.firstSeenAt,
    connectedAt: target.connectedAt,
    disconnectedAt: target.disconnectedAt,
  };
}

function deviceRecordToTarget(ctx: KernelContext, record: DeviceRecord): TargetDescriptor {
  return {
    targetId: record.device_id,
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
  };
}
