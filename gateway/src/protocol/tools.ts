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
};

export type RuntimeHostInventoryEntry = {
  nodeId: string;
  hostRole: HostRole;
  hostCapabilities: CapabilityId[];
  toolCapabilities: Record<string, CapabilityId[]>;
  tools: string[];
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
