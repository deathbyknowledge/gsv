import type { KernelContext } from "../context";
import type {
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysDeviceUpdateArgs,
  SysDeviceUpdateResult,
  SysDeviceDetail,
  SysDeviceSummary,
} from "@gsv/protocol/syscalls/system";
import type { DeviceRecord } from "../devices";

function ownerUsername(record: DeviceRecord, ctx: KernelContext): string | null {
  return ctx.auth?.getPasswdByUid(record.owner_uid)?.username ?? null;
}

function toSummary(record: DeviceRecord, ctx: KernelContext): SysDeviceSummary {
  return {
    deviceId: record.device_id,
    ownerUid: record.owner_uid,
    ownerUsername: ownerUsername(record, ctx),
    description: record.description,
    platform: record.platform,
    version: record.version,
    online: record.online,
    lastSeenAt: record.last_seen_at,
  };
}

function toDetail(record: DeviceRecord, ctx: KernelContext): SysDeviceDetail {
  const summary = toSummary(record, ctx);
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
    devices: visible.map((device) => toSummary(device, ctx)),
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
    device: toDetail(record, ctx),
  };
}

export function handleSysDeviceUpdate(
  args: SysDeviceUpdateArgs,
  ctx: KernelContext,
): SysDeviceUpdateResult {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { deviceId?: unknown; description?: unknown };
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    throw new Error("sys.device.update requires deviceId");
  }

  const record = ctx.devices.get(deviceId);
  if (!record || !ctx.devices.canAccess(deviceId, identity.uid, identity.gids)) {
    return { device: null };
  }
  if (identity.uid !== 0 && record.owner_uid !== identity.uid) {
    throw new Error("Permission denied: device metadata is owner-managed");
  }
  if (typeof raw.description !== "string") {
    throw new Error("sys.device.update requires description");
  }

  ctx.devices.setDescription(deviceId, raw.description);
  const updated = ctx.devices.get(deviceId);
  return {
    device: updated ? toDetail(updated, ctx) : null,
  };
}
