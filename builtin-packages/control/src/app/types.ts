export type ControlTabId = "config" | "access" | "mcp" | "advanced";
export type ControlConfigSectionId = "ai" | "profiles" | "shell" | "server" | "processes" | "automation";
export type ControlTokenKind = "node" | "service" | "user";
export type ControlMcpTransportType = "auto" | "streamable-http" | "sse";
export type ControlMcpConnectionState =
  | "not-connected"
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "ready"
  | "failed";

export type ControlConfigEntry = {
  key: string;
  value: string;
  scopeLabel: string;
  pathLabel: string;
};

export type ControlToken = {
  tokenId: string;
  uid: number;
  kind: ControlTokenKind;
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

export type ControlCreatedToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  uid: number;
  kind: ControlTokenKind;
  label: string | null;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type ControlLink = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid: number;
};

export type ControlMcpTool = {
  name: string;
  description: string | null;
  inputFields: string[];
  requiredInputFields: string[];
  outputFields: string[];
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

export type ControlMcpServer = {
  serverId: string;
  uid: number;
  name: string;
  url: string;
  transport: ControlMcpTransportType;
  state: ControlMcpConnectionState;
  authUrl: string | null;
  error: string | null;
  instructions: string | null;
  tools: ControlMcpTool[];
  resourceCount: number;
  promptCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ControlViewer = {
  uid: number;
  username: string;
  canEditSystemConfig: boolean;
  canEditUserAiConfig: boolean;
  userAiPrefix: string;
};

export type ControlState = {
  viewer: ControlViewer;
  configEntries: ControlConfigEntry[];
  configValues: Record<string, string>;
  tokens: ControlToken[];
  links: ControlLink[];
  mcpServers: ControlMcpServer[];
};

export type SaveEntryArgs = {
  key: string;
  value: string;
};

export type CreateTokenArgs = {
  kind: ControlTokenKind;
  label?: string;
  allowedDeviceId?: string;
  expiresAt?: number | null;
};

export type RevokeTokenArgs = {
  tokenId: string;
  reason?: string;
};

export type ConsumeLinkCodeArgs = {
  code: string;
};

export type CreateLinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type UnlinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type ApplyRawConfigArgs = {
  entries: SaveEntryArgs[];
};

export type AddMcpServerArgs = {
  name: string;
  url: string;
  transport: ControlMcpTransportType;
};

export type RefreshMcpServerArgs = {
  serverId: string;
};

export type RemoveMcpServerArgs = {
  serverId: string;
};

export type CreateTokenResult = {
  state: ControlState;
  token: ControlCreatedToken;
};

export type McpServerMutationResult = {
  state: ControlState;
  server: ControlMcpServer | null;
};

export interface ControlBackend {
  loadState(args?: Record<string, never>): Promise<ControlState>;
  saveEntry(args: SaveEntryArgs): Promise<ControlState>;
  createToken(args: CreateTokenArgs): Promise<CreateTokenResult>;
  revokeToken(args: RevokeTokenArgs): Promise<ControlState>;
  consumeLinkCode(args: ConsumeLinkCodeArgs): Promise<ControlState>;
  createLink(args: CreateLinkArgs): Promise<ControlState>;
  unlink(args: UnlinkArgs): Promise<ControlState>;
  applyRawConfig(args: ApplyRawConfigArgs): Promise<ControlState>;
  addMcpServer(args: AddMcpServerArgs): Promise<McpServerMutationResult>;
  refreshMcpServer(args: RefreshMcpServerArgs): Promise<McpServerMutationResult>;
  removeMcpServer(args: RemoveMcpServerArgs): Promise<ControlState>;
}
