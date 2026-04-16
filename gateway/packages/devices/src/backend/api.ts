import type { KernelClientLike, PackageAppRpcContext } from "@gsv/package/worker";
import type {
  SysDeviceDetail,
  SysDeviceGetResult,
  SysDeviceListResult,
  SysTokenCreateResult,
  SysTokenListResult,
} from "../../../../src/syscalls/system";
import type {
  CreateNodeTokenArgs,
  CreateNodeTokenResult,
  DeviceSummary,
  DevicesState,
  DevicesViewer,
  IssuedNodeToken,
  LoadDevicesStateArgs,
  RevokeTokenArgs,
} from "../app/types";

export async function loadState(
  args: LoadDevicesStateArgs | undefined,
  kernel: KernelClientLike,
  runtime: PackageAppRpcContext,
): Promise<DevicesState> {
  const viewer = resolveViewer(runtime);
  const [deviceList, tokenList] = await Promise.all([
    kernel.request("sys.device.list", { includeOffline: true }) as Promise<SysDeviceListResult>,
    kernel.request("sys.token.list", {}) as Promise<SysTokenListResult>,
  ]);

  const devices = [...deviceList.devices].sort((left, right) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return left.deviceId.localeCompare(right.deviceId);
  }).map(normalizeDeviceSummary);

  const requestedDeviceId = typeof args?.deviceId === "string" && args.deviceId.trim().length > 0
    ? args.deviceId.trim()
    : null;
  const selectedDeviceId = requestedDeviceId && devices.some((device) => device.deviceId === requestedDeviceId)
    ? requestedDeviceId
    : devices[0]?.deviceId ?? null;

  const detail = selectedDeviceId
    ? await kernel.request("sys.device.get", { deviceId: selectedDeviceId }) as SysDeviceGetResult
    : { device: null };

  const deviceTokens = [...tokenList.tokens]
    .filter((token) => token.kind === "node" && token.allowedDeviceId === selectedDeviceId)
    .sort((left, right) => right.createdAt - left.createdAt);

  return {
    viewer,
    devices,
    selectedDeviceId,
    selectedDevice: detail.device ? normalizeDeviceDetail(detail.device) : null,
    deviceTokens,
  };
}

export async function createNodeToken(
  args: CreateNodeTokenArgs,
  kernel: KernelClientLike,
  runtime: PackageAppRpcContext,
): Promise<CreateNodeTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: "node",
    allowedRole: "driver",
    allowedDeviceId: normalizeRequired(args.deviceId, "deviceId"),
    ...(normalizeOptional(args.label) ? { label: normalizeOptional(args.label) } : {}),
    ...(typeof args.expiresAt === "number" ? { expiresAt: args.expiresAt } : {}),
  }) as SysTokenCreateResult;

  return {
    state: await loadState({ deviceId: result.token.allowedDeviceId ?? args.deviceId }, kernel, runtime),
    token: normalizeIssuedToken(result.token),
  };
}

export async function revokeToken(
  args: RevokeTokenArgs,
  kernel: KernelClientLike,
  runtime: PackageAppRpcContext,
): Promise<DevicesState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: "devices access revoked",
  });
  const selectedDeviceId = normalizeOptional(args.deviceId);
  return loadState(selectedDeviceId ? { deviceId: selectedDeviceId } : {}, kernel, runtime);
}

function resolveViewer(runtime: PackageAppRpcContext): DevicesViewer {
  const uid = runtime.viewer.uid;
  const username = runtime.viewer.username || (uid === 0 ? "root" : "user");
  return {
    uid,
    username,
    canManageTokens: true,
  };
}

function normalizeDeviceSummary(device: DeviceSummary): DeviceSummary {
  return {
    deviceId: device.deviceId,
    ownerUid: device.ownerUid,
    platform: device.platform,
    version: device.version,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
  };
}

function normalizeDeviceDetail(device: SysDeviceDetail): SysDeviceDetail {
  return {
    deviceId: device.deviceId,
    ownerUid: device.ownerUid,
    platform: device.platform,
    version: device.version,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    implements: [...device.implements].sort(),
    firstSeenAt: device.firstSeenAt,
    connectedAt: device.connectedAt,
    disconnectedAt: device.disconnectedAt,
  };
}

function normalizeIssuedToken(token: SysTokenCreateResult["token"]): IssuedNodeToken {
  return {
    tokenId: token.tokenId,
    token: token.token,
    tokenPrefix: token.tokenPrefix,
    label: token.label,
    allowedDeviceId: token.allowedDeviceId,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  };
}

function normalizeRequired(value: string | undefined, field: string): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}
