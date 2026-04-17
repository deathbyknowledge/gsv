import type { KernelContext } from "../context";
import type {
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysDeviceDetail,
  SysDeviceSummary,
} from "@gsv/protocol/syscalls/system";
import type { DeviceRecord } from "../devices";

function toSummary(record: DeviceRecord): SysDeviceSummary {
  return {
    deviceId: record.device_id,
    ownerUid: record.owner_uid,
    platform: record.platform,
    version: record.version,
    online: record.online,
    lastSeenAt: record.last_seen_at,
  };
}

function toDetail(record: DeviceRecord): SysDeviceDetail {
  const summary = toSummary(record);
  return {
    ...summary,
    implements: record.implements,
    firstSeenAt: record.first_seen_at,
    connectedAt: record.connected_at,
    disconnectedAt: record.disconnected_at,
  };
}

export function handleSysDeviceList(
  args: SysDeviceListArgs,
  ctx: KernelContext,
): SysDeviceListResult {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { includeOffline?: unknown };
  const includeOffline = raw.includeOffline === true;
  const all = ctx.devices.listForUser(identity.uid, identity.gids);
  const visible = includeOffline ? all : all.filter((device) => device.online);

  return {
    devices: visible.map(toSummary),
  };
}

export function handleSysDeviceGet(
  args: SysDeviceGetArgs,
  ctx: KernelContext,
): SysDeviceGetResult {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { deviceId?: unknown };
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    throw new Error("sys.device.get requires deviceId");
  }

  if (!ctx.devices.canAccess(deviceId, identity.uid, identity.gids)) {
    return { device: null };
  }

  const record = ctx.devices.get(deviceId);
  if (!record) {
    return { device: null };
  }

  return {
    device: toDetail(record),
  };
}
