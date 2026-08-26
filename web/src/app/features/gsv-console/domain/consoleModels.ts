export type ConsoleProcessState = "running" | "queued" | "waiting_hil" | "idle" | "unknown";

export type ConsoleProcess = {
  pid: string;
  label: string;
  state: ConsoleProcessState;
  rawState: string;
  uid: number | null;
  username: string;
  profile: string;
  cwd: string;
  parentPid: string | null;
  interactive: boolean;
  personal: boolean;
  activeRunId: string | null;
  queuedCount: number;
  createdAt: number | null;
  lastActiveAt: number | null;
};

export type ConsoleTargetKind = "native-device" | "browser" | "unknown";

export type ConsoleTarget = {
  deviceId: string;
  kind: ConsoleTargetKind;
  ownerUid: number | null;
  ownerUsername: string | null;
  label: string;
  description: string;
  platform: string;
  version: string;
  online: boolean;
  lastSeenAt: number | null;
  implements: string[];
};

export type ConsoleAccountRelation = "self" | "personal-agent" | "agent" | "human" | "unknown";

export type ConsoleAccount = {
  uid: number;
  username: string;
  displayName: string;
  relation: ConsoleAccountRelation;
  runnable: boolean;
  gecos: string;
  capabilities: string[];
};

export type ConsoleAdapterAccount = {
  adapter: string;
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode: string;
  lastActivity: number | null;
  error: string;
  extra: JsonObject;
};

export type ConsoleAdapter = {
  adapter: string;
  available: boolean;
  supportsConnect: boolean;
  supportsDisconnect: boolean;
  supportsSend: boolean;
  supportsStatus: boolean;
  supportsActivity: boolean;
  supportsPairing: boolean;
  accounts: ConsoleAdapterAccount[];
};

export type ConsoleIdentityLink = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number | null;
  linkedByUid: number | null;
};

export type ConsoleMcpTransport = "auto" | "streamable-http" | "sse" | "unknown";

export type ConsoleMcpConnectionState =
  | "not-connected"
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "ready"
  | "failed"
  | "unknown";

export type ConsoleMcpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject | null;
  outputSchema: JsonObject | null;
};

export type ConsoleMcpServer = {
  serverId: string;
  uid: number | null;
  name: string;
  url: string;
  transport: ConsoleMcpTransport;
  state: ConsoleMcpConnectionState;
  authUrl: string;
  error: string;
  instructions: string;
  capabilities: JsonObject | null;
  tools: ConsoleMcpTool[];
  resourceCount: number;
  promptCount: number;
  createdAt: number | null;
  updatedAt: number | null;
};

export type ConsoleConfigEntry = {
  key: string;
  value: string;
  redacted: boolean;
};

export type ConsoleOverviewData = {
  loadedAt: number;
  processes: ConsoleProcess[];
  targets: ConsoleTarget[];
  accounts: ConsoleAccount[];
  adapterInventory: ConsoleAdapter[];
  adapters: ConsoleAdapterAccount[];
  mcpServers: ConsoleMcpServer[];
  config: ConsoleConfigEntry[];
};

export type ConsoleOverviewCounts = {
  processes: number;
  activeProcesses: number;
  queuedProcesses: number;
  targets: number;
  onlineTargets: number;
  accounts: number;
  runnableAccounts: number;
  adapters: number;
  availableAdapters: number;
  adapterAccounts: number;
  connectedAdapterAccounts: number;
  mcpServers: number;
  readyMcpServers: number;
  configEntries: number;
};

export type ConsoleResourceState<T> = {
  data: T | null;
  isUnavailable: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  isError: boolean;
  errorText: string;
  isEmpty: boolean;
};
import type { JsonObject } from "@humansandmachines/gsv/protocol";
