import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClientManager } from "agents/mcp/client";

type McpConnection = MCPClientManager["mcpConnections"][string];

const NORMALIZED_CONNECTION = Symbol("gsv.mcp.normalized-connection");
const PATCHED_MANAGER = Symbol("gsv.mcp.patched-manager");

type NormalizedConnection = McpConnection & {
  [NORMALIZED_CONNECTION]?: true;
};

type PatchedManager = MCPClientManager & {
  [PATCHED_MANAGER]?: true;
};

/**
 * Compatibility for MCP transports that wrap JSON-RPC method-not-found errors
 * inside a generic transport Error. Agents only recognizes a top-level code.
 * Tracked in cloudflare/agents#787; remove after upstream handles this shape.
 */
export function installMcpDiscoveryCompatibility(manager: MCPClientManager): void {
  const patchedManager = manager as PatchedManager;
  if (patchedManager[PATCHED_MANAGER]) {
    return;
  }

  const discoverIfConnected = manager.discoverIfConnected.bind(manager);
  manager.discoverIfConnected = async (serverId, options) => {
    const connection = manager.mcpConnections[serverId];
    if (connection) {
      normalizeConnection(connection);
    }
    return discoverIfConnected(serverId, options);
  };
  patchedManager[PATCHED_MANAGER] = true;
}

function normalizeConnection(connection: McpConnection): void {
  const normalized = connection as NormalizedConnection;
  if (normalized[NORMALIZED_CONNECTION]) {
    return;
  }

  const client = connection.client;
  client.listTools = normalizeListMethod(client, client.listTools);
  client.listResources = normalizeListMethod(client, client.listResources);
  client.listPrompts = normalizeListMethod(client, client.listPrompts);
  client.listResourceTemplates = normalizeListMethod(
    client,
    client.listResourceTemplates,
  );

  const discover = connection.discover.bind(connection);
  connection.discover = async (options) => {
    const result = await discover(options);
    connection.connectionError = result.success
      ? null
      : `Failed to discover MCP server capabilities: ${result.error ?? "unknown discovery error"}`;
    return result;
  };

  normalized[NORMALIZED_CONNECTION] = true;
}

function normalizeListMethod<Args extends unknown[], Result>(
  client: Client,
  list: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await list.apply(client, args);
    } catch (error) {
      const message = errorMessage(error);
      if (isRecord(error) && error.code === ErrorCode.MethodNotFound) {
        throw error;
      }
      if (/"code"\s*:\s*-32601(?:\s*[,}])/.test(message)) {
        throw new McpError(ErrorCode.MethodNotFound, message);
      }
      throw error;
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
