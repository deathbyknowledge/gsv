export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const CAPABILITY_IDS = [
  "filesystem.list",
  "filesystem.read",
  "filesystem.write",
  "filesystem.edit",
  "text.search",
  "shell.exec",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type NodeRuntimeInfo = {
  hostCapabilities: CapabilityId[];
  toolCapabilities: Record<string, CapabilityId[]>;
};

export type RuntimeHostInventoryEntry = {
  nodeId: string;
  online: boolean;
  hostCapabilities: CapabilityId[];
  toolCapabilities: Record<string, CapabilityId[]>;
  tools: string[];
  firstSeenAt?: number;
  lastSeenAt?: number;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  clientPlatform?: string;
  clientVersion?: string;
};

export type RuntimeNodeInventory = {
  hosts: RuntimeHostInventoryEntry[];
};

export type ToolRequestParams = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  sessionKey: string;
};

export type ToolResultParams = {
  callId: string;
  result?: unknown;
  error?: string;
};

export type ToolInvokePayload = {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
};

export const NODE_EXEC_EVENT_TYPES = [
  "started",
  "finished",
  "failed",
  "timed_out",
] as const;
export type NodeExecEventType = (typeof NODE_EXEC_EVENT_TYPES)[number];

export type NodeExecEventParams = {
  eventId: string;
  sessionId: string;
  event: NodeExecEventType;
  callId?: string;
  exitCode?: number | null;
  signal?: string;
  outputTail?: string;
  startedAt?: number;
  endedAt?: number;
};
