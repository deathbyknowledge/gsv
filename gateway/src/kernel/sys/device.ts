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
import { z } from "zod";

const deviceArgsSchema = z.object({
  includeOffline: z.boolean().optional(),
  deviceId: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});
type DeviceMetadata = { label?: string; description?: string };

export function handleSysDeviceList(
  args: SysDeviceListArgs,
  ctx: KernelContext,
): SysDeviceListResult {
  if (!ctx.identity?.process) {
    throw new Error("Authentication required");
  }

  const raw = deviceArgsSchema.parse(args ?? {});
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

  const raw = deviceArgsSchema.parse(args ?? {});
  const deviceId = raw.deviceId?.trim() ?? "";
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

  const raw = deviceArgsSchema.parse(args ?? {});
  const deviceId = raw.deviceId?.trim() ?? "";
  if (!deviceId) {
    throw new Error("sys.device.update requires deviceId");
  }

  const target = getVisibleTarget(ctx, deviceId, { includeOffline: true });
  if (!target) {
    return { device: null };
  }
  if (raw.label === undefined && raw.description === undefined) {
    throw new Error("sys.device.update requires label or description");
  }

  const metadata: DeviceMetadata = {};
  if (raw.label !== undefined) metadata.label = raw.label;
  if (raw.description !== undefined) metadata.description = raw.description;
  const updated = updateTargetMetadata(ctx, deviceId, metadata);
  return {
    device: updated ? targetToDeviceDetail(updated) : null,
  };
}

export function handleSysDeviceDelete(
  args: SysDeviceDeleteArgs,
  ctx: KernelContext,
): SysDeviceDeleteResult {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("Authentication required");
  }

  const raw = deviceArgsSchema.parse(args ?? {});
  const deviceId = raw.deviceId?.trim() ?? "";
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

  const revokedTokens = ctx.auth
    .listTokens(identity.uid === 0 ? undefined : identity.uid)
    .filter((token) =>
      token.kind === "node" &&
      token.allowedDeviceId === deviceId &&
      token.revokedAt === null
    )
    .reduce((count, token) => (
      ctx.auth.revokeToken(token.tokenId, "machine forgotten", identity.uid === 0 ? undefined : identity.uid)
        ? count + 1
        : count
    ), 0);

  return {
    deleted: ctx.devices.remove(deviceId),
    deviceId,
    revokedTokens,
  };
}
