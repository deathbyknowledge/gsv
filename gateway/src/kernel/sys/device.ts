import type { KernelContext } from "../context";
import type {
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysDeviceDeleteArgs,
  SysDeviceDeleteResult,
  SysDeviceUpdateArgs,
  SysDeviceUpdateResult,
} from "@humansandmachines/gsv/protocol";
import {
  getVisibleTarget,
  listVisibleTargets,
  targetToDeviceDetail,
  targetToDeviceSummary,
  updateTargetMetadata,
} from "../targets";

export function handleSysDeviceList(
  args: SysDeviceListArgs,
  ctx: KernelContext,
): SysDeviceListResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { includeOffline?: unknown };
  const includeOffline = raw.includeOffline === true;

  return {
    devices: listVisibleTargets(ctx, { includeOffline }).map(targetToDeviceSummary),
  };
}

export function handleSysDeviceGet(
  args: SysDeviceGetArgs,
  ctx: KernelContext,
): SysDeviceGetResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { deviceId?: unknown };
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    throw new Error("sys.device.get requires deviceId");
  }

  const target = getVisibleTarget(ctx, deviceId, { includeOffline: true });

  return {
    device: target ? targetToDeviceDetail(target) : null,
  };
}

export function handleSysDeviceUpdate(
  args: SysDeviceUpdateArgs,
  ctx: KernelContext,
): SysDeviceUpdateResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { deviceId?: unknown; label?: unknown; description?: unknown };
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    throw new Error("sys.device.update requires deviceId");
  }

  const target = getVisibleTarget(ctx, deviceId, { includeOffline: true });
  if (!target) {
    return { device: null };
  }
  if (raw.label !== undefined && typeof raw.label !== "string") {
    throw new Error("sys.device.update label must be a string");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    throw new Error("sys.device.update description must be a string");
  }
  if (raw.label === undefined && raw.description === undefined) {
    throw new Error("sys.device.update requires label or description");
  }

  const updated = updateTargetMetadata(ctx, deviceId, {
    ...(raw.label !== undefined ? { label: raw.label } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
  });
  return {
    device: updated ? targetToDeviceDetail(updated) : null,
  };
}

export async function handleSysDeviceDelete(
  args: SysDeviceDeleteArgs,
  ctx: KernelContext,
): Promise<SysDeviceDeleteResult> {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = (args ?? {}) as { deviceId?: unknown };
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId.trim() : "";
  if (!deviceId) {
    throw new Error("sys.device.delete requires deviceId");
  }

  const device = ctx.devices.get(deviceId);
  if (!device || !ctx.devices.canAccess(deviceId, identity.uid, identity.gids)) {
    return { deleted: false, deviceId, revokedTokens: 0 };
  }
  if (identity.uid !== 0 && device.owner_uid !== identity.uid) {
    throw new Error("Permission denied: machine forgetting is owner-managed");
  }

  // The Master commits every credential revocation (and its durable delivery
  // record) before the user Kernel removes the local device record.
  const revocations = await ctx.revokeDeviceCredentials(device.owner_uid, deviceId);

  return {
    deleted: ctx.devices.remove(deviceId),
    deviceId,
    revokedTokens: revocations.length,
  };
}
