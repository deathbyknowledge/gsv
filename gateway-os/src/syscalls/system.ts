export type ProcessIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
  workspaceId: string | null;
};

export type ConnectionIdentity = UserIdentity | DeviceIdentity | ServiceIdentity;

export type UserIdentity = {
  role: "user";
  process: ProcessIdentity;
  capabilities: string[];
};

export type DeviceIdentity = {
  role: "driver";
  process: ProcessIdentity;
  capabilities: string[];
  device: string;
  implements: string[];
};

export type ServiceIdentity = {
  role: "service";
  process: ProcessIdentity;
  capabilities: string[];
  channel: string;
};

export type ConnectArgs = {
  protocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    role: "user" | "driver" | "service";
    channel?: string;
  };
  driver?: {
    implements: string[];
  };
  auth?: {
    username: string;
    password?: string;
    token?: string;
  };
};

export type ConnectResult = {
  protocol: number;
  server: {
    version: string;
    connectionId: string;
  };
  identity: ConnectionIdentity;
  syscalls: string[];
  signals: string[];
};

export type UserPermissions = {
  uid: number;
  grants: string[];
  denials: string[];
};

// -- sys.setup ---------------------------------------------------------------

export type SysSetupArgs = {
  username: string;
  password: string;
  rootPassword?: string;
  ai?: {
    provider?: string;
    model?: string;
    apiKey?: string;
  };
  node?: {
    deviceId: string;
    label?: string;
    expiresAt?: number;
  };
};

export type SysSetupResult = {
  user: ProcessIdentity;
  rootLocked: boolean;
  nodeToken?: {
    tokenId: string;
    token: string;
    tokenPrefix: string;
    uid: number;
    kind: "node";
    label: string | null;
    allowedRole: "driver" | null;
    allowedDeviceId: string | null;
    createdAt: number;
    expiresAt: number | null;
  };
};

// -- sys.config.get / sys.config.set -----------------------------------------

export type SysConfigGetArgs = {
  key?: string;
};

export type SysConfigEntry = {
  key: string;
  value: string;
};

export type SysConfigGetResult = {
  entries: SysConfigEntry[];
};

export type SysConfigSetArgs = {
  key: string;
  value: string;
};

export type SysConfigSetResult = {
  ok: true;
};

// -- sys.device.list / sys.device.get ----------------------------------------

export type SysDeviceListArgs = {
  includeOffline?: boolean;
};

export type SysDeviceSummary = {
  deviceId: string;
  ownerUid: number;
  platform: string;
  version: string;
  online: boolean;
  lastSeenAt: number;
};

export type SysDeviceListResult = {
  devices: SysDeviceSummary[];
};

export type SysDeviceGetArgs = {
  deviceId: string;
};

export type SysDeviceDetail = SysDeviceSummary & {
  implements: string[];
  firstSeenAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
};

export type SysDeviceGetResult = {
  device: SysDeviceDetail | null;
};

// -- sys.workspace.list ------------------------------------------------------

export type SysWorkspaceKind = "thread" | "app" | "shared";
export type SysWorkspaceState = "active" | "archived";

export type SysWorkspaceListArgs = {
  uid?: number;
  kind?: SysWorkspaceKind;
  state?: SysWorkspaceState;
  limit?: number;
};

export type SysWorkspaceProcessSummary = {
  pid: string;
  label: string | null;
  cwd: string;
  createdAt: number;
};

export type SysWorkspaceSummary = {
  workspaceId: string;
  ownerUid: number;
  label: string | null;
  kind: SysWorkspaceKind;
  state: SysWorkspaceState;
  createdAt: number;
  updatedAt: number;
  defaultBranch: string;
  headCommit: string | null;
  activeProcess: SysWorkspaceProcessSummary | null;
  processCount: number;
};

export type SysWorkspaceListResult = {
  workspaces: SysWorkspaceSummary[];
};

// -- sys.token.create / sys.token.list / sys.token.revoke -------------------

export type SysTokenKind = "node" | "service" | "user";
export type SysTokenRole = "driver" | "service" | "user";

export type SysTokenCreateArgs = {
  uid?: number;
  kind: SysTokenKind;
  label?: string;
  allowedRole?: SysTokenRole;
  allowedDeviceId?: string;
  expiresAt?: number;
};

export type SysTokenCreateResult = {
  token: {
    tokenId: string;
    token: string;
    tokenPrefix: string;
    uid: number;
    kind: SysTokenKind;
    label: string | null;
    allowedRole: SysTokenRole | null;
    allowedDeviceId: string | null;
    createdAt: number;
    expiresAt: number | null;
  };
};

export type SysTokenRecord = {
  tokenId: string;
  uid: number;
  kind: SysTokenKind;
  label: string | null;
  tokenPrefix: string;
  allowedRole: SysTokenRole | null;
  allowedDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
};

export type SysTokenListArgs = {
  uid?: number;
};

export type SysTokenListResult = {
  tokens: SysTokenRecord[];
};

export type SysTokenRevokeArgs = {
  tokenId: string;
  reason?: string;
  uid?: number;
};

export type SysTokenRevokeResult = {
  revoked: boolean;
};

// -- sys.link.consume ---------------------------------------------------------

export type SysLinkConsumeArgs = {
  code: string;
};

export type SysLinkConsumeResult = {
  linked: boolean;
  link?: {
    adapter: string;
    accountId: string;
    actorId: string;
    uid: number;
    createdAt: number;
  };
};

// -- sys.link / sys.unlink / sys.link.list ----------------------------------

export type SysLinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid?: number;
};

export type SysLinkResult = {
  linked: boolean;
  link?: {
    adapter: string;
    accountId: string;
    actorId: string;
    uid: number;
    createdAt: number;
  };
};

export type SysUnlinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type SysUnlinkResult = {
  removed: boolean;
};

export type SysLinkListArgs = {
  uid?: number;
};

export type SysLinkListResult = {
  links: Array<{
    adapter: string;
    accountId: string;
    actorId: string;
    uid: number;
    createdAt: number;
    linkedByUid: number;
  }>;
};
