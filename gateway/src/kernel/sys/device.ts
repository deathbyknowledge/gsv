import type { KernelContext } from "../context";
import type {
  SysDeviceListArgs,
  SysDeviceListResult,
  SysDeviceGetArgs,
  SysDeviceGetResult,
  SysDeviceUpdateArgs,
  SysDeviceUpdateResult,
} from "@gsv/protocol/syscalls/system";
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
