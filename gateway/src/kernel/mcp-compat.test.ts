import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClientManager } from "agents/mcp/client";
import { describe, expect, it, vi } from "vitest";
import { installMcpDiscoveryCompatibility } from "./mcp-compat";

type McpConnection = MCPClientManager["mcpConnections"][string];

function makeManager(options: {
  discover?: (client: Client) => Promise<{ success: boolean; error?: string }>;
  listPrompts?: () => Promise<unknown>;
  discoveryResult?: { success: boolean; error?: string };
} = {}) {
  const listPrompts = vi.fn(options.listPrompts ?? (async () => ({ prompts: [] })));
  const client = {
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    listPrompts,
    listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  } as unknown as Client;
  const discover = vi.fn(async () => options.discover?.(client)
    ?? options.discoveryResult
    ?? { success: true });
  const connection = {
    client,
    connectionError: null,
    discover,
  } as unknown as McpConnection;
  const manager = {
    mcpConnections: { server: connection },
    discoverIfConnected: vi.fn(async (serverId: string) => {
      const result = await manager.mcpConnections[serverId].discover();
      return { ...result, state: "ready" as const };
    }),
  } as unknown as MCPClientManager;
  return { client, connection, discover, listPrompts, manager };
}

describe("MCP discovery compatibility", () => {
  it("normalizes wrapped method-not-found errors for Agents discovery", async () => {
    const wrappedError = new Error(
      'Streamable HTTP error: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":6}',
    );
    const { connection, listPrompts, manager } = makeManager({
      listPrompts: async () => {
        throw wrappedError;
      },
      discover: async (normalizedClient) => {
        try {
          await normalizedClient.listPrompts();
          return { success: true };
        } catch (error) {
          return error instanceof McpError && error.code === ErrorCode.MethodNotFound
            ? { success: true }
            : { success: false, error: "prompt discovery failed" };
        }
      },
    });
    installMcpDiscoveryCompatibility(manager);
    const result = await manager.discoverIfConnected("server");

    expect(result?.success).toBe(true);
    expect(listPrompts).toHaveBeenCalledTimes(1);
    expect(connection.connectionError).toBeNull();
  });

  it("preserves native MCP method-not-found errors", async () => {
    const methodNotFound = new McpError(ErrorCode.MethodNotFound, "Method not found");
    const { client, manager } = makeManager({
      listPrompts: async () => {
        throw methodNotFound;
      },
    });
    installMcpDiscoveryCompatibility(manager);
    await manager.discoverIfConnected("server");

    await expect(client.listPrompts()).rejects.toBe(methodNotFound);
  });

  it("records non-optional discovery failures on their connection", async () => {
    const { connection, manager } = makeManager({
      discoveryResult: { success: false, error: "tools/list timed out" },
    });
    installMcpDiscoveryCompatibility(manager);

    await manager.discoverIfConnected("server");

    expect(connection.connectionError).toBe(
      "Failed to discover MCP server capabilities: tools/list timed out",
    );
  });

  it("installs only once", async () => {
    const { connection, discover, manager } = makeManager();
    installMcpDiscoveryCompatibility(manager);
    installMcpDiscoveryCompatibility(manager);

    await manager.discoverIfConnected("server");

    expect(discover).toHaveBeenCalledTimes(1);
    expect(connection.connectionError).toBeNull();
  });
});
