import {
  jsonObjectSchema,
  type SysMcpAddArgs,
  type SysMcpAddResult,
  type SysMcpCallArgs,
  type SysMcpCallResult,
  type SysMcpConnectionState,
  type SysMcpListArgs,
  type SysMcpListResult,
  type SysMcpRefreshArgs,
  type SysMcpRefreshResult,
  type SysMcpRemoveArgs,
  type SysMcpRemoveResult,
  type SysMcpServerSummary,
  type SysMcpToolSummary,
  type SysMcpTransportType,
} from "@humansandmachines/gsv/protocol";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
const sdkMcpServerRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  server_url: z.string(),
  client_id: z.string().nullable(),
  auth_url: z.string().nullable(),
  callback_url: z.string(),
  server_options: z.string().nullable(),
});
const sdkMcpServerRowsSchema = z.array(sdkMcpServerRowSchema);
const sdkMcpToolsSchema = z.array(ToolSchema);
const mcpCallResultProjectionSchema = z.object({
  content: z.json().optional(),
  structuredContent: z.json().optional(),
  isError: z.boolean().optional(),
});
const sdkTransportOptionsSchema = z.object({
  transport: z.object({
    type: z.enum(["auto", "streamable-http", "sse"]),
  }),
});

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
  ctx.broadcastToUserUid(effectiveUid, "mcp.changed");
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
    ctx.broadcastToUserUid(effectiveUid, "mcp.changed");
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
  const providerResult = await ctx.callMcpTool(
    serverId,
    toolName,
    args.arguments ?? {},
    ctx.requestSignal,
  );
  const result = mcpCallResultProjectionSchema.parse(providerResult);
  const response: SysMcpCallResult = {};
  if (result.content !== undefined) response.content = result.content;
  if (result.structuredContent !== undefined) {
    response.structuredContent = result.structuredContent;
  }
  if (result.isError !== undefined) response.isError = result.isError;
  return response;
}

export function summarizeServer(record: McpServerRecord, ctx: KernelContext): SysMcpServerSummary {
  const server = findSdkMcpServer(ctx, record.serverId);
  const connection = ctx.mcp.mcpConnections[record.serverId];
  const tools = sdkMcpToolsSchema.parse(ctx.mcp.listTools({ serverId: record.serverId }));
  const resources = ctx.mcp.listResources({ serverId: record.serverId });
  const prompts = ctx.mcp.listPrompts({ serverId: record.serverId });
  const error = connection?.connectionError ?? null;
  const capabilities = jsonObjectSchema.safeParse(connection?.serverCapabilities);
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
    authUrl: server?.auth_url ?? null,
    error,
    instructions: connection?.instructions ?? null,
    capabilities: capabilities.success ? capabilities.data : null,
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
  return sdkMcpServerRowsSchema.parse(ctx.mcp.listServers())
    .find((item) => item.id === serverId);
}

function parseSdkServerTransport(server: SdkMcpServerRow | undefined): SysMcpTransportType {
  if (!server?.server_options) {
    return "auto";
  }
  try {
    const options = sdkTransportOptionsSchema.safeParse(JSON.parse(server.server_options));
    return options.success ? options.data.transport.type : "auto";
  } catch {
    return "auto";
  }
}

function summarizeTool(tool: Tool): SysMcpToolSummary {
  const inputSchema = jsonObjectSchema.safeParse(tool.inputSchema);
  const outputSchema = jsonObjectSchema.safeParse(tool.outputSchema);
  return {
    name: tool.name,
    description: tool.description ?? null,
    inputSchema: inputSchema.success ? inputSchema.data : null,
    outputSchema: outputSchema.success ? outputSchema.data : null,
  };
}

function parseEffectiveUid(input: number | undefined, ctx: KernelContext, action: string): number {
  const callerUid = ctx.identity!.process.uid;
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (input !== undefined) {
    if (!Number.isInteger(input) || input < 0) {
      throw new Error("uid must be a non-negative integer");
    }
    if (callerUid !== 0 && input !== callerUid && input !== ownerUid) {
      throw new Error(`Permission denied: cannot ${action} for another user`);
    }
    return input;
  }
  return ownerUid;
}

function parseName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw new Error("name must be 1-80 characters");
  }
  return trimmed;
}

function parseId(input: string, field: string): string {
  if (input.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return input.trim();
}

function parseServerUrl(input: string): string {
  const url = new URL(input);
  if (!isSecureOrLoopbackUrl(url)) {
    throw new Error("url must use https, except localhost development URLs");
  }
  return url.href;
}

function parseOptionalCallbackHost(input: string | undefined): string | undefined {
  if (input === undefined || input === "") {
    return undefined;
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

function parseTransport(
  input: SysMcpAddArgs["transport"],
): McpAddConnectionInput["transport"] {
  if (input === undefined) {
    return { type: "auto" };
  }
  const type = input.type ?? "auto";
  if (!MCP_TRANSPORT_TYPES.has(type)) {
    throw new Error("transport.type must be auto, streamable-http, or sse");
  }
  const transport: McpAddConnectionInput["transport"] = { type };
  if (input.headers !== undefined) {
    transport.headers = input.headers;
  }
  return transport;
}

function parseConnectionState(input: string | undefined): SysMcpConnectionState {
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
