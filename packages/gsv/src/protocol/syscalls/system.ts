export type ProcessIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
  cwd: string;
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

/**
 * Account kinds in the unified identity model.
 * - `human`: a real person who logs in (password), member of `users`, gets a
 *   1:1 personal agent and an init process.
 * - `agent`: a non-login service identity owned by a human; runs *as* itself
 *   while the owning human owns its processes.
 */
export type AccountKind = "human" | "agent";

export type AccountCreateArgs = {
  kind: AccountKind;
  /** `^[a-z_][a-z0-9_-]{0,31}$`, globally unique across users and groups. */
  username: string;
  /** Required for `kind: "human"`; must be at least 8 characters. */
  password?: string;
  /** Optional GECOS/display string. */
  gecos?: string;
  /** Optional persona seed for `kind: "agent"` (written to context.d/05-persona.md). */
  persona?: string;
  /** Optional additional context.d files for `kind: "agent"`. */
  contextFiles?: Array<{ name: string; text: string }>;
};

export type AccountCreateResult = {
  account: ProcessIdentity;
  kind: AccountKind;
  /** For `kind: "human"`: the provisioned 1:1 personal agent identity. */
  personalAgent?: ProcessIdentity;
};

/** How the listing caller relates to a listed account. */
export type AccountRelation = "self" | "personal-agent" | "agent" | "human";

export type AccountSummary = {
  uid: number;
  username: string;
  displayName: string;
  relation: AccountRelation;
  /** Whether the caller may run processes as this account. */
  runnable: boolean;
  /** Resolved runtime capabilities for this account's process identity. */
  capabilities?: string[];
  gecos?: string;
};

export type AccountListArgs = {
  /** Owning human whose run-as-able accounts to list. Defaults to the caller. Root may target any uid. */
  uid?: number;
};

export type AccountListResult = {
  accounts: AccountSummary[];
};

export type SysSetupArgs = {
  username: string;
  password: string;
  rootPassword?: string;
  /** Optional name for the user's 1:1 personal agent account (defaults to a curated name). */
  agentName?: string;
  bootstrap?: {
    remoteUrl?: string;
    repo?: string;
    ref?: string;
  };
  ai?: {
    provider?: string;
    model?: string;
    apiKey?: string;
  };
  timezone?: string;
  node?: {
    deviceId: string;
    label?: string;
    expiresAt?: number;
  };
};

export type OnboardingLane = "quick" | "customize" | "advanced";
export type OnboardingMode = "manual" | "guided";
export type OnboardingStage = "welcome" | "details" | "review";
export type OnboardingDetailStep = "account" | "admin" | "system" | "ai" | "source" | "device";

export type OnboardingDraft = {
  lane: OnboardingLane;
  mode: OnboardingMode;
  stage: OnboardingStage;
  detailStep: OnboardingDetailStep;
  account: {
    username: string;
    agentName: string;
    password: string;
    passwordConfirm: string;
  };
  admin: {
    mode: "same" | "custom";
    password: string;
    passwordConfirm: string;
  };
  system: {
    timezone: string;
  };
  ai: {
    enabled: boolean;
    provider: string;
    model: string;
    apiKey: string;
  };
  source: {
    enabled: boolean;
    value: string;
    ref: string;
  };
  device: {
    enabled: boolean;
    deviceId: string;
    label: string;
    expiryDays: string;
  };
};

export type OnboardingAssistMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OnboardingAssistPatch = {
  op: "set" | "clear";
  path:
    | "account.username"
    | "account.agentName"
    | "admin.mode"
    | "system.timezone"
    | "ai.enabled"
    | "ai.provider"
    | "ai.model"
    | "source.enabled"
    | "source.value"
    | "source.ref"
    | "device.enabled"
    | "device.deviceId"
    | "device.label"
    | "device.expiryDays";
  value?: string | boolean;
};

export type SysSetupAssistArgs = {
  lane: OnboardingLane;
  draft: OnboardingDraft;
  messages: OnboardingAssistMessage[];
};

export type SysSetupAssistResult = {
  message: string;
  patches: OnboardingAssistPatch[];
  reviewReady: boolean;
  focus?: string;
};

export type SysSetupResult = {
  user: ProcessIdentity;
  rootLocked: boolean;
  bootstrap?: SysBootstrapResult;
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

export type SysBootstrapArgs = {
  remoteUrl?: string;
  repo?: string;
  ref?: string;
};

export type SysCliReleaseChannel = "stable" | "dev";

export type SysCliDownloadsResult = {
  defaultChannel: SysCliReleaseChannel;
  mirroredChannels: SysCliReleaseChannel[];
  assets: string[];
  refreshedAt: number;
};

export type SysUpdateArgs = {
  channel?: SysCliReleaseChannel;
};

export type SysUpdateResult = {
  updatedAt: number;
  cli: SysCliDownloadsResult;
};

export type SysBootstrapResult = {
  repo: string;
  remoteUrl: string;
  ref: string;
  head: string | null;
  changed: boolean;
  manual: {
    repo: string;
    remoteUrl: string;
    ref: string;
    head: string | null;
    changed: boolean;
  };
  cli: SysCliDownloadsResult;
  packages: Array<{
    packageId: string;
    name: string;
    description: string;
    version: string;
    runtime: "dynamic-worker" | "node" | "web-ui";
    enabled: boolean;
    source: {
      repo: string;
      ref: string;
      subdir: string;
      resolvedCommit: string | null;
    };
    entrypoints: Array<{
      name: string;
      kind: "command" | "ui";
      description?: string;
      command?: string;
      route?: string;
      icon?: string;
      syscalls?: string[];
      windowDefaults?: {
        width: number;
        height: number;
        minWidth: number;
        minHeight: number;
      };
    }>;
  }>;
};

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
} & (
  | { value: string; copyFromKey?: never }
  | { copyFromKey: string; value?: never }
);

export type SysConfigSetResult = {
  ok: true;
};

export type SysDeviceListArgs = {
  includeOffline?: boolean;
};

export type SysDeviceSummary = {
  deviceId: string;
  ownerUid: number;
  ownerUsername: string | null;
  label: string;
  description: string;
  implements: string[];
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
  firstSeenAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
};

export type SysDeviceGetResult = {
  device: SysDeviceDetail | null;
};

export type SysDeviceUpdateArgs = {
  deviceId: string;
  label?: string;
  description?: string;
};

export type SysDeviceUpdateResult = {
  device: SysDeviceDetail | null;
};

export type SysDeviceDeleteArgs = {
  deviceId: string;
};

export type SysDeviceDeleteResult = {
  deleted: boolean;
  deviceId: string;
  revokedTokens: number;
};

export type SysOAuthConnectionKind = "ai-provider" | "mcp-server" | "generic";

export type SysOAuthStartArgs = {
  uid?: number;
  kind: SysOAuthConnectionKind;
  provider: string;
  accountKey?: string;
  label?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  extraAuthParams?: Record<string, string>;
};

export type SysOAuthFlowSummary = {
  flowId: string;
  uid: number;
  kind: SysOAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string | null;
  resource: string | null;
  createdAt: number;
  expiresAt: number;
};

export type SysOAuthAccountSummary = {
  accountId: string;
  uid: number;
  kind: SysOAuthConnectionKind;
  provider: string;
  accountKey: string;
  label: string | null;
  scope: string | null;
  resource: string | null;
  clientId: string;
  tokenType: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  metadata: Record<string, unknown>;
};

export type SysOAuthStartResult = {
  authorizationUrl: string;
  flow: SysOAuthFlowSummary;
};

export type SysOAuthDeviceStartArgs = {
  uid?: number;
  kind: "ai-provider";
  provider: "openai-codex";
  accountKey?: string;
  label?: string;
};

export type SysOAuthDeviceStartResult = {
  flow: SysOAuthFlowSummary;
  provider: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
};

export type SysOAuthDevicePollArgs = {
  uid?: number;
  flowId: string;
};

export type SysOAuthDevicePollResult =
  | {
      status: "pending";
      flow: SysOAuthFlowSummary;
      intervalSeconds: number;
      expiresAt: number;
    }
  | {
      status: "complete";
      account: SysOAuthAccountSummary;
    };

export type SysOAuthListArgs = {
  uid?: number;
  includePending?: boolean;
};

export type SysOAuthListResult = {
  accounts: SysOAuthAccountSummary[];
  flows?: SysOAuthFlowSummary[];
};

export type SysOAuthForgetArgs = {
  accountId: string;
  uid?: number;
};

export type SysOAuthForgetResult = {
  forgotten: boolean;
};

export type SysMcpTransportType = "auto" | "streamable-http" | "sse";

export type SysMcpConnectionState =
  | "not-connected"
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "ready"
  | "failed";

export type SysMcpToolSummary = {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
};

export type SysMcpServerSummary = {
  serverId: string;
  uid: number;
  name: string;
  url: string;
  transport: SysMcpTransportType;
  state: SysMcpConnectionState;
  authUrl: string | null;
  error: string | null;
  instructions: string | null;
  capabilities: Record<string, unknown> | null;
  tools: SysMcpToolSummary[];
  createdAt: number;
  updatedAt: number;
};

export type SysMcpAddArgs = {
  uid?: number;
  name: string;
  url: string;
  callbackHost?: string;
  transport?: {
    type?: SysMcpTransportType;
    headers?: Record<string, string>;
  };
};

export type SysMcpAddResult = {
  server: SysMcpServerSummary;
};

export type SysMcpListArgs = {
  uid?: number;
};

export type SysMcpListResult = {
  servers: SysMcpServerSummary[];
};

export type SysMcpRemoveArgs = {
  uid?: number;
  serverId: string;
};

export type SysMcpRemoveResult = {
  removed: boolean;
};

export type SysMcpRefreshArgs = {
  uid?: number;
  serverId: string;
};

export type SysMcpRefreshResult = {
  server: SysMcpServerSummary | null;
};

export type SysMcpCallArgs = {
  uid?: number;
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
};

export type SysMcpCallResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

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
