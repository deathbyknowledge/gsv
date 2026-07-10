import type {
  SysMcpAddArgs,
  SysMcpAddResult,
  SysMcpCallArgs,
  SysMcpCallResult,
  SysMcpConnectionState,
  SysMcpListArgs,
  SysMcpListResult,
  SysMcpRefreshArgs,
  SysMcpRefreshResult,
  SysMcpRemoveArgs,
  SysMcpRemoveResult,
  SysMcpServerSummary,
  SysMcpToolSummary,
  SysMcpTransportType,
} from "@humansandmachines/gsv/protocol";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveCallerOwnerUid, type KernelContext } from "../context";
import type { McpServerRecord } from "../mcp-store";

export type McpAddConnectionInput = {
  uid: number;
  name: string;
  url: string;
  callbackHost?: string;
  transport: {
    type: SysMcpTransportType;
    headers?: Record<string, string>;
  };
};

export type McpAddConnectionResult = {
  id: string;
};

type SdkMcpServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

const MCP_TRANSPORT_TYPES = new Set<SysMcpTransportType>(["auto", "streamable-http", "sse"]);

export async function handleSysMcpAdd(
  args: SysMcpAddArgs,
  ctx: KernelContext,
): Promise<SysMcpAddResult> {
  const effectiveUid = parseEffectiveUid(args.uid, ctx, "add MCP servers");
  const name = parseName(args.name);
  const url = parseServerUrl(args.url);
  const callbackHost = parseOptionalCallbackHost(args.callbackHost);
  const transport = parseTransport(args.transport);

  const existing = findUserMcpServerByNameUrl(ctx, effectiveUid, name, url);
  if (existing) {
    return { server: summarizeServer(existing, ctx) };
  }

  const connection = await ctx.addMcpServerConnection({
    uid: effectiveUid,
    name,
    url,
    callbackHost,
    transport,
  });

  const record = ctx.mcpServers.upsert({
    serverId: connection.id,
    uid: effectiveUid,
    name,
  });
  ctx.broadcastToUid(effectiveUid, "mcp.changed");
  return { server: summarizeServer(record, ctx) };
}

export function handleSysMcpList(
  args: SysMcpListArgs,
  ctx: KernelContext,
): SysMcpListResult {
  const effectiveUid = parseEffectiveUid(args.uid, ctx, "list MCP servers");
  return {
    servers: ctx.mcpServers.list(effectiveUid).map((record) => summarizeServer(record, ctx)),
  };
}

export async function handleSysMcpRemove(
  args: SysMcpRemoveArgs,
  ctx: KernelContext,
): Promise<SysMcpRemoveResult> {
  const serverId = parseId(args.serverId, "serverId");
  const effectiveUid = parseEffectiveUid(args.uid, ctx, "remove MCP servers");
  const record = ctx.mcpServers.get(serverId);
  if (!record || record.uid !== effectiveUid) {
    return { removed: false };
  }

  await ctx.removeMcpServerConnection(serverId);
  const removed = ctx.mcpServers.delete(serverId, effectiveUid);
  if (removed) {
    ctx.broadcastToUid(effectiveUid, "mcp.changed");
  }
  return { removed };
}

export async function handleSysMcpRefresh(
  args: SysMcpRefreshArgs,
  ctx: KernelContext,
): Promise<SysMcpRefreshResult> {
  const serverId = parseId(args.serverId, "serverId");
  const effectiveUid = parseEffectiveUid(args.uid, ctx, "refresh MCP servers");
  const record = ctx.mcpServers.get(serverId);
  if (!record || record.uid !== effectiveUid) {
    return { server: null };
  }

  await ctx.refreshMcpServerConnection(serverId);
  return { server: summarizeServer(record, ctx) };
}

export async function handleSysMcpCall(
  args: SysMcpCallArgs,
  ctx: KernelContext,
): Promise<SysMcpCallResult> {
  const serverId = parseId(args.serverId, "serverId");
  const toolName = parseId(args.name, "name");
  const effectiveUid = parseEffectiveUid(args.uid, ctx, "call MCP tools");
  const record = ctx.mcpServers.get(serverId);
  if (!record || record.uid !== effectiveUid) {
    throw new Error("MCP server not found");
  }
  const result = await ctx.callMcpTool(
    serverId,
    toolName,
    isRecord(args.arguments) ? args.arguments : {},
  ) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  return {
    ...(result.content !== undefined ? { content: result.content } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

export function summarizeServer(record: McpServerRecord, ctx: KernelContext): SysMcpServerSummary {
  const server = findSdkMcpServer(ctx, record.serverId);
  const connection = ctx.mcp.mcpConnections[record.serverId];
  const tools = ctx.mcp.listTools({ serverId: record.serverId }) as Tool[];
  const resources = ctx.mcp.listResources({ serverId: record.serverId });
  const prompts = ctx.mcp.listPrompts({ serverId: record.serverId });
  const error = typeof connection?.connectionError === "string"
    ? connection.connectionError
    : null;
  const state = connection
    ? parseConnectionState(connection.connectionState)
    : server?.auth_url ? "authenticating" : "not-connected";

  return {
    serverId: record.serverId,
    uid: record.uid,
    name: record.name,
    url: server?.server_url ?? "",
    transport: parseSdkServerTransport(server),
    state: error && state === "connected" ? "failed" : state,
    authUrl: typeof server?.auth_url === "string" ? server.auth_url : null,
    error,
    instructions: typeof connection?.instructions === "string" ? connection.instructions : null,
    capabilities: isRecord(connection?.serverCapabilities) ? connection.serverCapabilities : null,
    tools: tools.map(summarizeTool),
    resourceCount: resources.length,
    promptCount: prompts.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function findUserMcpServerByNameUrl(
  ctx: KernelContext,
  uid: number,
  name: string,
  url: string,
): McpServerRecord | null {
  for (const record of ctx.mcpServers.findByUidName(uid, name)) {
    const server = findSdkMcpServer(ctx, record.serverId);
    if (server?.server_url === url) {
      return record;
    }
  }
  return null;
}

function findSdkMcpServer(ctx: KernelContext, serverId: string): SdkMcpServerRow | undefined {
  return (ctx.mcp.listServers() as SdkMcpServerRow[])
    .find((item) => item.id === serverId);
}

function parseSdkServerTransport(server: SdkMcpServerRow | undefined): SysMcpTransportType {
  if (!server?.server_options) {
    return "auto";
  }
  try {
    const options = JSON.parse(server.server_options) as unknown;
    if (!isRecord(options) || !isRecord(options.transport)) {
      return "auto";
    }
    const type = options.transport.type;
    return typeof type === "string" && MCP_TRANSPORT_TYPES.has(type as SysMcpTransportType)
      ? type as SysMcpTransportType
      : "auto";
  } catch {
    return "auto";
  }
}

function summarizeTool(tool: Tool): SysMcpToolSummary {
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : null,
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : null,
    outputSchema: isRecord(tool.outputSchema) ? tool.outputSchema : null,
  };
}

function parseEffectiveUid(input: unknown, ctx: KernelContext, action: string): number {
  const callerUid = ctx.identity!.process.uid;
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (input !== undefined && input !== null) {
    if (!Number.isInteger(input) || (input as number) < 0) {
      throw new Error("uid must be a non-negative integer");
    }
    if (callerUid !== 0 && input !== callerUid && input !== ownerUid) {
      throw new Error(`Permission denied: cannot ${action} for another user`);
    }
    return input as number;
  }
  return ownerUid;
}

function parseName(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("name is required");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw new Error("name must be 1-80 characters");
  }
  return trimmed;
}

function parseId(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return input.trim();
}

function parseServerUrl(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("url is required");
  }
  const url = new URL(input);
  if (!isSecureOrLoopbackUrl(url)) {
    throw new Error("url must use https, except localhost development URLs");
  }
  return url.href;
}

function parseOptionalCallbackHost(input: unknown): string | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }
  if (typeof input !== "string") {
    throw new Error("callbackHost must be a URL origin");
  }
  const url = new URL(input);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("callbackHost must be a URL origin");
  }
  if (!isSecureOrLoopbackUrl(url)) {
    throw new Error("callbackHost must use https, except localhost development URLs");
  }
  return url.origin;
}

function isSecureOrLoopbackUrl(url: URL): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && (
    url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "::1"
    || url.hostname === "[::1]"
  );
}

function parseTransport(input: unknown): McpAddConnectionInput["transport"] {
  if (input === undefined || input === null) {
    return { type: "auto" };
  }
  if (!isRecord(input)) {
    throw new Error("transport must be an object");
  }
  const rawType = input.type;
  const type = rawType === undefined ? "auto" : rawType;
  if (typeof type !== "string" || !MCP_TRANSPORT_TYPES.has(type as SysMcpTransportType)) {
    throw new Error("transport.type must be auto, streamable-http, or sse");
  }
  const headers = parseHeaders(input.headers);
  return {
    type: type as SysMcpTransportType,
    ...(headers ? { headers } : {}),
  };
}

function parseHeaders(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (!isRecord(input)) {
    throw new Error("transport.headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new Error("transport.headers values must be strings");
    }
    headers[key] = value;
  }
  return headers;
}

function parseConnectionState(input: unknown): SysMcpConnectionState {
  switch (input) {
    case "authenticating":
    case "connecting":
    case "connected":
    case "discovering":
    case "ready":
    case "failed":
      return input;
    default:
      return "not-connected";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
