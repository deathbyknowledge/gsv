import type { KernelClientLike, PackageViewerBinding } from "@gsv/package/backend";
import type {
  CreateNodeTokenArgs,
  CreateNodeTokenResult,
  DeviceDetail,
  DeviceSummary,
  DeviceToken,
  DevicesState,
  DevicesViewer,
  IssuedNodeToken,
  LoadDevicesStateArgs,
  RevokeDeviceTokenArgs,
  UpdateDeviceDescriptionArgs,
} from "../app/features/devices/types";

type ViewerRuntime = {
  viewer?: PackageViewerBinding;
};

type DeviceListPayload = {
  devices?: DeviceSummary[];
};

type DeviceDetailPayload = {
  device?: DeviceDetail | null;
};

type TokenListPayload = {
  tokens?: Array<Record<string, unknown>>;
};

type CreatedTokenPayload = {
  token?: Record<string, unknown>;
};

export async function loadDevicesState(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: LoadDevicesStateArgs = {},
): Promise<DevicesState> {
  const viewer = resolveViewer(runtime);
  const [deviceList, tokenList] = await Promise.all([
    kernel.request("sys.device.list", { includeOffline: true }) as Promise<DeviceListPayload>,
    kernel.request("sys.token.list", {}) as Promise<TokenListPayload>,
  ]);

  const devices = [...(Array.isArray(deviceList.devices) ? deviceList.devices : [])]
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.deviceId.localeCompare(right.deviceId);
    })
    .map(normalizeDeviceSummary);

  const requestedDeviceId = typeof args.deviceId === "string" && args.deviceId.trim().length > 0
    ? args.deviceId.trim()
    : null;
  const selectedDeviceId = requestedDeviceId && devices.some((device) => device.deviceId === requestedDeviceId)
    ? requestedDeviceId
    : null;

  const detail = selectedDeviceId
    ? await kernel.request("sys.device.get", { deviceId: selectedDeviceId }) as DeviceDetailPayload
    : { device: null };

  const tokens = Array.isArray(tokenList.tokens) ? tokenList.tokens : [];
  const deviceTokens = tokens
    .filter((token) => token.kind === "node" && (selectedDeviceId === null || token.allowedDeviceId === selectedDeviceId))
    .map(normalizeToken)
    .sort((left, right) => right.createdAt - left.createdAt);

  return {
    viewer,
    devices,
    selectedDeviceId,
    selectedDevice: detail.device ? normalizeDeviceDetail(detail.device) : null,
    deviceTokens,
  };
}

export async function createDeviceNodeToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: CreateNodeTokenArgs,
): Promise<CreateNodeTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: "node",
    allowedRole: "driver",
    allowedDeviceId: normalizeRequired(args.deviceId, "deviceId"),
    ...(normalizeOptional(args.label) ? { label: normalizeOptional(args.label) } : {}),
    ...(typeof args.expiresAt === "number" ? { expiresAt: args.expiresAt } : {}),
  }) as CreatedTokenPayload;

  const token = normalizeIssuedToken(result.token ?? {});
  return {
    state: await loadDevicesState(kernel, runtime, { deviceId: token.allowedDeviceId ?? args.deviceId }),
    token,
  };
}

export async function revokeDeviceToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RevokeDeviceTokenArgs,
): Promise<DevicesState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: "devices access revoked",
  });
  const selectedDeviceId = normalizeOptional(args.deviceId);
  return loadDevicesState(kernel, runtime, selectedDeviceId ? { deviceId: selectedDeviceId } : {});
}

export async function updateDeviceDescription(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: UpdateDeviceDescriptionArgs,
): Promise<DevicesState> {
  const deviceId = normalizeRequired(args.deviceId, "deviceId");
  await kernel.request("sys.device.update", {
    deviceId,
    description: args.description ?? "",
  });
  return loadDevicesState(kernel, runtime, { deviceId });
}

function resolveViewer(runtime: ViewerRuntime): DevicesViewer {
  const uid = runtime.viewer?.uid ?? 0;
  const username = runtime.viewer?.username || (uid === 0 ? "root" : "user");
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
    ownerUsername: typeof device.ownerUsername === "string" && device.ownerUsername.trim()
      ? device.ownerUsername.trim()
      : null,
    description: device.description ?? "",
    platform: device.platform,
    version: device.version,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
  };
}

function normalizeDeviceDetail(device: DeviceDetail): DeviceDetail {
  return {
    ...normalizeDeviceSummary(device),
    implements: [...(device.implements ?? [])].sort(),
    firstSeenAt: device.firstSeenAt,
    connectedAt: device.connectedAt,
    disconnectedAt: device.disconnectedAt,
  };
}

function normalizeToken(token: Record<string, unknown>): DeviceToken {
  const kind: DeviceToken["kind"] = token.kind === "service" || token.kind === "user" ? token.kind : "node";
  return {
    tokenId: String(token.tokenId ?? ""),
    uid: Number(token.uid ?? 0),
    kind,
    label: typeof token.label === "string" ? token.label : null,
    tokenPrefix: String(token.tokenPrefix ?? ""),
    allowedRole: typeof token.allowedRole === "string" ? token.allowedRole : null,
    allowedDeviceId: typeof token.allowedDeviceId === "string" ? token.allowedDeviceId : null,
    createdAt: Number(token.createdAt ?? 0),
    lastUsedAt: typeof token.lastUsedAt === "number" ? token.lastUsedAt : null,
    expiresAt: typeof token.expiresAt === "number" ? token.expiresAt : null,
    revokedAt: typeof token.revokedAt === "number" ? token.revokedAt : null,
    revokedReason: typeof token.revokedReason === "string" ? token.revokedReason : null,
  };
}

function normalizeIssuedToken(token: Record<string, unknown>): IssuedNodeToken {
  return {
    tokenId: String(token.tokenId ?? ""),
    token: String(token.token ?? ""),
    tokenPrefix: String(token.tokenPrefix ?? ""),
    label: typeof token.label === "string" ? token.label : null,
    allowedDeviceId: typeof token.allowedDeviceId === "string" ? token.allowedDeviceId : null,
    createdAt: Number(token.createdAt ?? 0),
    expiresAt: typeof token.expiresAt === "number" ? token.expiresAt : null,
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
