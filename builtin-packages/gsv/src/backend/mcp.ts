import type {
  AddMcpServerArgs,
  McpConnectionState,
  McpServer,
  McpServerMutationResult,
  McpState,
  McpTool,
  McpTransportType,
  RefreshMcpServerArgs,
  RemoveMcpServerArgs,
} from "../app/features/integrations/types";

type KernelClientLike = {
  request(method: string, payload?: unknown): Promise<unknown>;
};

export async function loadMcpState(kernel: KernelClientLike): Promise<McpState> {
  const result = await kernel.request("sys.mcp.list", {});
  const raw = asRecord(result) ?? {};
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  return {
    servers: normalizeMcpServers(servers),
  };
}

export async function addMcpServer(
  kernel: KernelClientLike,
  args: AddMcpServerArgs,
): Promise<McpServerMutationResult> {
  const result = await kernel.request("sys.mcp.add", {
    name: normalizeRequired(args?.name, "name"),
    url: normalizeRequired(args?.url, "url"),
    callbackHost: normalizeOptional(args?.callbackHost),
    transport: { type: normalizeMcpTransport(args?.transport) },
  });
  const raw = asRecord(result) ?? {};
  const server = normalizeMcpServer(raw.server);
  return {
    state: await loadMcpState(kernel),
    server,
  };
}

export async function refreshMcpServer(
  kernel: KernelClientLike,
  args: RefreshMcpServerArgs,
): Promise<McpServerMutationResult> {
  const result = await kernel.request("sys.mcp.refresh", {
    serverId: normalizeRequired(args?.serverId, "serverId"),
  });
  const raw = asRecord(result) ?? {};
  return {
    state: await loadMcpState(kernel),
    server: raw.server ? normalizeMcpServer(raw.server) : null,
  };
}

export async function removeMcpServer(
  kernel: KernelClientLike,
  args: RemoveMcpServerArgs,
): Promise<McpState> {
  await kernel.request("sys.mcp.remove", {
    serverId: normalizeRequired(args?.serverId, "serverId"),
  });
  return loadMcpState(kernel);
}

function normalizeMcpServers(servers: unknown[]): McpServer[] {
  return servers
    .map(normalizeMcpServer)
    .filter((server): server is McpServer => server !== null)
    .sort((left, right) => {
      const stateRank = mcpStateRank(left.state) - mcpStateRank(right.state);
      return stateRank === 0 ? right.updatedAt - left.updatedAt : stateRank;
    });
}

function normalizeMcpServer(value: unknown): McpServer | null {
  const server = asRecord(value);
  if (!server) {
    return null;
  }
  return {
    serverId: asString(server.serverId, "unknown"),
    uid: asNumber(server.uid, 0),
    name: asString(server.name, "Unnamed server"),
    url: asString(server.url, ""),
    transport: normalizeMcpTransport(server.transport),
    state: normalizeMcpState(server.state),
    authUrl: asNullableString(server.authUrl),
    error: asNullableString(server.error),
    instructions: asNullableString(server.instructions),
    tools: Array.isArray(server.tools) ? server.tools.map(normalizeMcpTool) : [],
    resourceCount: asNumber(server.resourceCount, 0),
    promptCount: asNumber(server.promptCount, 0),
    createdAt: asNumber(server.createdAt, 0),
    updatedAt: asNumber(server.updatedAt, 0),
  };
}

function normalizeMcpTool(value: unknown): McpTool {
  const tool = asRecord(value) ?? {};
  const inputSchema = asNullableRecord(tool.inputSchema);
  const outputSchema = asNullableRecord(tool.outputSchema);
  return {
    name: asString(tool.name, "unknown"),
    description: asNullableString(tool.description),
    inputFields: schemaFields(inputSchema),
    requiredInputFields: schemaRequiredFields(inputSchema),
    outputFields: schemaFields(outputSchema),
    hasInputSchema: inputSchema !== null,
    hasOutputSchema: outputSchema !== null,
  };
}

function normalizeMcpTransport(value: unknown): McpTransportType {
  return value === "streamable-http" || value === "sse" ? value : "auto";
}

function normalizeMcpState(value: unknown): McpConnectionState {
  switch (value) {
    case "authenticating":
    case "connecting":
    case "connected":
    case "discovering":
    case "ready":
    case "failed":
      return value;
    default:
      return "not-connected";
  }
}

function mcpStateRank(state: McpConnectionState): number {
  switch (state) {
    case "authenticating":
      return 0;
    case "failed":
      return 1;
    case "connecting":
    case "connected":
    case "discovering":
      return 2;
    case "ready":
      return 3;
    default:
      return 4;
  }
}

function schemaFields(schema: Record<string, unknown> | null): string[] {
  const properties = asRecord(schema?.properties);
  if (!properties) {
    return [];
  }
  return Object.keys(properties).sort((left, right) => left.localeCompare(right));
}

function schemaRequiredFields(schema: Record<string, unknown> | null): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
