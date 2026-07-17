import type {
  AiToolsDevice,
  SysDeviceDetail,
  SysDeviceSummary,
} from "@humansandmachines/gsv/protocol";
import type { AdapterTarget } from "./adapter-targets";
import { getVisibleAdapterTarget, listVisibleAdapterTargets } from "./adapter-targets";
import { hasCapability } from "./capabilities";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { DeviceRecord } from "./devices";

export type TargetProviderId = "device" | "adapter";

export type TargetRoute =
  | { kind: "connection" }
  | { kind: "adapter"; adapter: string; accountId: string };

export type TargetDescriptor = {
  targetId: string;
  providerId: TargetProviderId;
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
  metadataWritable: boolean;
  route: TargetRoute;
};

export type TargetListOptions = {
  includeOffline?: boolean;
};

type TargetMetadataPatch = {
  label?: string;
  description?: string;
};

export type TargetProvider = {
  id: TargetProviderId;
  list(ctx: KernelContext, options: TargetListOptions): TargetDescriptor[];
  get(ctx: KernelContext, targetId: string, options: TargetListOptions): TargetDescriptor | null;
  updateMetadata?(
    ctx: KernelContext,
    target: TargetDescriptor,
    patch: TargetMetadataPatch,
  ): TargetDescriptor | null;
};

const DEVICE_PROVIDER: TargetProvider = {
  id: "device",
  list(ctx, options) {
    const identity = ctx.identity?.process;
    if (!identity) {
      return [];
    }

    return ctx.devices
      .listForUser(identity.uid, identity.gids)
      .filter((device) => options.includeOffline || device.online)
      .map((device) => deviceRecordToTarget(ctx, device));
  },
  get(ctx, targetId, options) {
    const identity = ctx.identity?.process;
    if (!identity || !ctx.devices.canAccess(targetId, identity.uid, identity.gids)) {
      return null;
    }

    const device = ctx.devices.get(targetId);
    if (!device || (!options.includeOffline && !device.online)) {
      return null;
    }

    return deviceRecordToTarget(ctx, device);
  },
  updateMetadata(ctx, target, patch) {
    ctx.devices.setMetadata(target.targetId, patch);
    const device = ctx.devices.get(target.targetId);
    return device ? deviceRecordToTarget(ctx, device) : null;
  },
};

const ADAPTER_PROVIDER: TargetProvider = {
  id: "adapter",
  list(ctx, options) {
    return listVisibleAdapterTargets(ctx, options)
      .map((target) => adapterTargetToDescriptor(ctx, target))
      .filter((target) => options.includeOffline || target.online);
  },
  get(ctx, targetId, options) {
    const target = getVisibleAdapterTarget(ctx, targetId, options);
    if (!target) {
      return null;
    }
    const descriptor = adapterTargetToDescriptor(ctx, target);
    return options.includeOffline || descriptor.online ? descriptor : null;
  },
};

const TARGET_PROVIDERS: TargetProvider[] = [
  DEVICE_PROVIDER,
  ADAPTER_PROVIDER,
];

export function listVisibleTargets(
  ctx: KernelContext,
  options: TargetListOptions = {},
): TargetDescriptor[] {
  return TARGET_PROVIDERS.flatMap((provider) => provider.list(ctx, options));
}

export function getVisibleTarget(
  ctx: KernelContext,
  targetId: string,
  options: TargetListOptions = {},
): TargetDescriptor | null {
  for (const provider of TARGET_PROVIDERS) {
    const target = provider.get(ctx, targetId, options);
    if (target) {
      return target;
    }
  }
  return null;
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
  if (!target.metadataWritable) {
    throw new Error("Permission denied: target metadata is read-only");
  }
  if (identity.uid !== 0 && target.ownerUid !== identity.uid) {
    throw new Error("Permission denied: device metadata is owner-managed");
  }

  const provider = TARGET_PROVIDERS.find((candidate) => candidate.id === target.providerId);
  return provider?.updateMetadata?.(ctx, target, patch) ?? null;
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
    implements: target.implements,
    firstSeenAt: target.firstSeenAt,
    connectedAt: target.connectedAt,
    disconnectedAt: target.disconnectedAt,
  };
}

function deviceRecordToTarget(ctx: KernelContext, record: DeviceRecord): TargetDescriptor {
  return {
    targetId: record.device_id,
    providerId: "device",
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
    metadataWritable: true,
    route: { kind: "connection" },
  };
}

function adapterTargetToDescriptor(ctx: KernelContext, target: AdapterTarget): TargetDescriptor {
  const identity = ctx.identity?.process;
  const ownerUid = ctx.identity?.role === "user"
    ? resolveCallerOwnerUid(ctx)
    : identity?.uid ?? 0;
  const online = target.status.connected && target.status.authenticated;
  return {
    targetId: target.targetId,
    providerId: "adapter",
    ownerUid,
    ownerUsername: ctx.auth.getPasswdByUid(ownerUid)?.username
      ?? (identity?.uid === ownerUid ? identity.username : null),
    label: target.label,
    description: target.description,
    platform: "adapter",
    version: "",
    online,
    implements: ["adapter.send"],
    firstSeenAt: target.status.updatedAt,
    lastSeenAt: target.status.lastActivity ?? target.status.updatedAt,
    connectedAt: online ? target.status.updatedAt : null,
    disconnectedAt: online ? null : target.status.updatedAt,
    metadataWritable: false,
    route: {
      kind: "adapter",
      adapter: target.adapter,
      accountId: target.accountId,
    },
  };
}
