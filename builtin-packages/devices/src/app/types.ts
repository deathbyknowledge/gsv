export type DevicesTabId = "overview" | "capabilities" | "access" | "health";
export type DevicesMode = "detail" | "provision";
export type DeviceScope = "all" | "online" | "offline";

export type DevicesViewer = {
  uid: number;
  username: string;
  canManageTokens: boolean;
};

export type DeviceSummary = {
  deviceId: string;
  ownerUid: number;
  platform: string;
  version: string;
  online: boolean;
  lastSeenAt: number;
};

export type DeviceDetail = DeviceSummary & {
  implements: string[];
  firstSeenAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
};

export type DeviceToken = {
  tokenId: string;
  uid: number;
  kind: "node" | "service" | "user";
  label: string | null;
  tokenPrefix: string;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
};

export type DevicesState = {
  viewer: DevicesViewer;
  devices: DeviceSummary[];
  selectedDeviceId: string | null;
  selectedDevice: DeviceDetail | null;
  deviceTokens: DeviceToken[];
};

export type LoadDevicesStateArgs = {
  deviceId?: string;
};

export type CreateNodeTokenArgs = {
  deviceId: string;
  label?: string;
  expiresAt?: number | null;
};

export type IssuedNodeToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  label: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type CreateNodeTokenResult = {
  state: DevicesState;
  token: IssuedNodeToken;
};

export type RevokeTokenArgs = {
  tokenId: string;
  deviceId?: string;
};

export interface DevicesBackend {
  loadState(args: LoadDevicesStateArgs): Promise<DevicesState>;
  createNodeToken(args: CreateNodeTokenArgs): Promise<CreateNodeTokenResult>;
  revokeToken(args: RevokeTokenArgs): Promise<DevicesState>;
}
