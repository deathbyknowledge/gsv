export type AdapterKind = "whatsapp" | "discord";

export type AdapterAccount = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: Record<string, unknown>;
};

export type AdapterConnectChallenge = {
  type: string;
  message?: string;
  data?: string;
  expiresAt?: number;
  extra?: Record<string, unknown>;
};

export type AdaptersState = {
  statusByAdapter: Record<AdapterKind, AdapterAccount[]>;
};

export type AdapterMutationResult = {
  ok: boolean;
  adapter: AdapterKind;
  accountId: string;
  connected?: boolean;
  authenticated?: boolean;
  statusText: string;
  error?: string;
  challenge?: AdapterConnectChallenge;
};

export type ConnectAdapterArgs = {
  adapter: AdapterKind;
  accountId: string;
  config?: Record<string, unknown>;
};

export type DisconnectAdapterArgs = {
  adapter: AdapterKind;
  accountId: string;
};

export type McpTransportType = "auto" | "streamable-http" | "sse";

export type McpConnectionState =
  | "not-connected"
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "ready"
  | "failed";

export type McpTool = {
  name: string;
  description: string | null;
  inputFields: string[];
  requiredInputFields: string[];
  outputFields: string[];
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

export type McpServer = {
  serverId: string;
  uid: number;
  name: string;
  url: string;
  transport: McpTransportType;
  state: McpConnectionState;
  authUrl: string | null;
  error: string | null;
  instructions: string | null;
  tools: McpTool[];
  resourceCount: number;
  promptCount: number;
  createdAt: number;
  updatedAt: number;
};

export type McpState = {
  servers: McpServer[];
};

export type AddMcpServerArgs = {
  name: string;
  url: string;
  transport: McpTransportType;
  callbackHost?: string;
};

export type RefreshMcpServerArgs = {
  serverId: string;
};

export type RemoveMcpServerArgs = {
  serverId: string;
};

export type McpServerMutationResult = {
  state: McpState;
  server: McpServer | null;
};

export type IntegrationKind = "message-adapters" | "mcp-servers";
