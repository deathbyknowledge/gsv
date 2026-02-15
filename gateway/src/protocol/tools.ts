export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const HOST_ROLES = ["execution", "specialized"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

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
  hostRole: HostRole;
  hostCapabilities: CapabilityId[];
  toolCapabilities: Record<string, CapabilityId[]>;
  hostOs?: string;
  hostEnv?: string[];
  hostBinStatus?: Record<string, boolean>;
  hostBinStatusUpdatedAt?: number;
};

export type RuntimeHostInventoryEntry = {
  nodeId: string;
  hostRole: HostRole;
  hostCapabilities: CapabilityId[];
  toolCapabilities: Record<string, CapabilityId[]>;
  tools: string[];
  hostOs?: string;
  hostEnv?: string[];
  hostBins?: string[];
  hostBinStatus?: Record<string, boolean>;
  hostBinStatusUpdatedAt?: number;
};

export type RuntimeNodeInventory = {
  executionHostId: string | null;
  specializedHostIds: string[];
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

export type NodeProbeKind = "bins";

export type NodeProbePayload = {
  probeId: string;
  kind: NodeProbeKind;
  bins: string[];
  timeoutMs?: number;
};

export type NodeProbeResultParams = {
  probeId: string;
  ok: boolean;
  bins?: Record<string, boolean>;
  error?: string;
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
