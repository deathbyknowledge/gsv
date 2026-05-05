import type { KernelClientLike, PackageViewerBinding } from "@gsv/package/backend";
import type {
  SysConfigEntry,
  SysConfigGetResult,
  SysLinkListResult,
  SysMcpAddResult,
  SysMcpListResult,
  SysMcpRefreshResult,
  SysMcpServerSummary,
  SysMcpToolSummary,
  SysMcpTransportType,
  SysTokenCreateResult,
  SysTokenListResult,
} from "@gsv/protocol/syscalls/system";
import type {
  AddMcpServerArgs,
  ApplyRawConfigArgs,
  ConsumeLinkCodeArgs,
  ControlConfigEntry,
  ControlCreatedToken,
  ControlMcpServer,
  ControlMcpTool,
  ControlMcpTransportType,
  ControlState,
  ControlViewer,
  CreateLinkArgs,
  CreateTokenArgs,
  CreateTokenResult,
  McpServerMutationResult,
  RefreshMcpServerArgs,
  RemoveMcpServerArgs,
  RevokeTokenArgs,
  SaveEntryArgs,
  UnlinkArgs,
} from "../app/types";

type ViewerRuntime = {
  viewer?: PackageViewerBinding;
};

export async function loadState(kernel: KernelClientLike, runtime: ViewerRuntime): Promise<ControlState> {
  const viewer = resolveViewer(runtime);
  const [configResult, tokenResult, linkResult, mcpResult] = await Promise.all([
    kernel.request("sys.config.get", {} as Record<string, never>) as Promise<SysConfigGetResult>,
    kernel.request("sys.token.list", {} as Record<string, never>) as Promise<SysTokenListResult>,
    kernel.request("sys.link.list", {} as Record<string, never>) as Promise<SysLinkListResult>,
    kernel.request("sys.mcp.list", {} as Record<string, never>) as Promise<SysMcpListResult>,
  ]);

  const configEntries = normalizeConfigEntries(configResult.entries);

  return {
    viewer,
    configEntries,
    configValues: Object.fromEntries(configEntries.map((entry) => [entry.key, entry.value])),
    tokens: [...tokenResult.tokens].sort((left, right) => right.createdAt - left.createdAt),
    links: [...linkResult.links].sort((left, right) => right.createdAt - left.createdAt),
    mcpServers: normalizeMcpServers(mcpResult.servers),
  };
}

export async function saveEntry(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: SaveEntryArgs,
): Promise<ControlState> {
  await kernel.request("sys.config.set", {
    key: normalizeRequired(args.key, "key"),
    value: args.value ?? "",
  });
  return loadState(kernel, runtime);
}

export async function createToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: CreateTokenArgs,
): Promise<CreateTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: args.kind,
    label: normalizeOptional(args.label),
    allowedDeviceId: normalizeOptional(args.allowedDeviceId),
    expiresAt: args.expiresAt ?? undefined,
  }) as SysTokenCreateResult;

  return {
    state: await loadState(kernel, runtime),
    token: normalizeCreatedToken(result.token),
  };
}

export async function revokeToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RevokeTokenArgs,
): Promise<ControlState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: normalizeOptional(args.reason),
  });
  return loadState(kernel, runtime);
}

export async function consumeLinkCode(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: ConsumeLinkCodeArgs,
): Promise<ControlState> {
  await kernel.request("sys.link.consume", {
    code: normalizeRequired(args.code, "code"),
  });
  return loadState(kernel, runtime);
}

export async function createLink(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: CreateLinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.link", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel, runtime);
}

export async function unlink(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: UnlinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.unlink", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel, runtime);
}

export async function applyRawConfig(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: ApplyRawConfigArgs,
): Promise<ControlState> {
  for (const entry of args.entries) {
    await kernel.request("sys.config.set", {
      key: normalizeRequired(entry.key, "key"),
      value: entry.value ?? "",
    });
  }
  return loadState(kernel, runtime);
}

export async function addMcpServer(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: AddMcpServerArgs,
): Promise<McpServerMutationResult> {
  const transport = normalizeMcpTransport(args.transport);
  const result = await kernel.request("sys.mcp.add", {
    name: normalizeRequired(args.name, "name"),
    url: normalizeRequired(args.url, "url"),
    transport: { type: transport },
  }) as SysMcpAddResult;

  return {
    state: await loadState(kernel, runtime),
    server: normalizeMcpServer(result.server),
  };
}

export async function refreshMcpServer(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RefreshMcpServerArgs,
): Promise<McpServerMutationResult> {
  const result = await kernel.request("sys.mcp.refresh", {
    serverId: normalizeRequired(args.serverId, "serverId"),
  }) as SysMcpRefreshResult;

  return {
    state: await loadState(kernel, runtime),
    server: result.server ? normalizeMcpServer(result.server) : null,
  };
}

export async function removeMcpServer(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RemoveMcpServerArgs,
): Promise<ControlState> {
  await kernel.request("sys.mcp.remove", {
    serverId: normalizeRequired(args.serverId, "serverId"),
  });
  return loadState(kernel, runtime);
}

function normalizeConfigEntries(entries: SysConfigEntry[]): ControlConfigEntry[] {
  return [...entries]
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
      scopeLabel: parseScopeLabel(entry.key),
      pathLabel: parsePathLabel(entry.key),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeMcpServers(servers: SysMcpServerSummary[]): ControlMcpServer[] {
  return servers
    .map(normalizeMcpServer)
    .sort((left, right) => {
      const stateRank = mcpStateRank(left.state) - mcpStateRank(right.state);
      return stateRank === 0 ? right.updatedAt - left.updatedAt : stateRank;
    });
}

function normalizeMcpServer(server: SysMcpServerSummary): ControlMcpServer {
  return {
    serverId: server.serverId,
    uid: server.uid,
    name: server.name,
    url: server.url,
    transport: server.transport,
    state: server.state,
    authUrl: server.authUrl,
    error: server.error,
    instructions: server.instructions,
    tools: server.tools.map(normalizeMcpTool),
    resourceCount: server.resourceCount,
    promptCount: server.promptCount,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

function normalizeMcpTool(tool: SysMcpToolSummary): ControlMcpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputFields: schemaFields(tool.inputSchema),
    requiredInputFields: schemaRequiredFields(tool.inputSchema),
    outputFields: schemaFields(tool.outputSchema),
    hasInputSchema: tool.inputSchema !== null,
    hasOutputSchema: tool.outputSchema !== null,
  };
}

function resolveViewer(runtime: ViewerRuntime): ControlViewer {
  const uid = typeof runtime.viewer?.uid === "number" ? runtime.viewer.uid : 0;
  const username = typeof runtime.viewer?.username === "string" && runtime.viewer.username.trim().length > 0
    ? runtime.viewer.username
    : uid === 0 ? "root" : "user";
  return {
    uid,
    username,
    canEditSystemConfig: uid === 0,
    canEditUserAiConfig: true,
    userAiPrefix: `users/${uid}/ai/`,
  };
}

function normalizeMcpTransport(input: ControlMcpTransportType): SysMcpTransportType {
  return input === "streamable-http" || input === "sse" ? input : "auto";
}

function mcpStateRank(state: ControlMcpServer["state"]): number {
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
  const properties = schema?.properties;
  if (!isRecord(properties)) {
    return [];
  }
  return Object.keys(properties).sort((left, right) => left.localeCompare(right));
}

function schemaRequiredFields(schema: Record<string, unknown> | null): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseScopeLabel(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] === "config") {
    return "system";
  }
  if (parts[0] === "users" && parts.length >= 2) {
    return `user ${parts[1]}`;
  }
  return "other";
}

function parsePathLabel(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] === "config") {
    return parts.slice(1).join(" / ");
  }
  if (parts[0] === "users" && parts.length >= 3) {
    return parts.slice(2).join(" / ");
  }
  return key;
}

function normalizeCreatedToken(token: SysTokenCreateResult["token"]): ControlCreatedToken {
  return {
    tokenId: token.tokenId,
    token: token.token,
    tokenPrefix: token.tokenPrefix,
    uid: token.uid,
    kind: token.kind,
    label: token.label,
    allowedRole: token.allowedRole,
    allowedDeviceId: token.allowedDeviceId,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  };
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
