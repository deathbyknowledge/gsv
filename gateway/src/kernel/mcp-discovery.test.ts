import { describe, expect, it, vi } from "vitest";
import {
  discoverMcpCapabilitiesLenient,
  isOptionalMcpListMethodNotFound,
  type LenientMcpConnection,
} from "./mcp-discovery";

function makeConnection(): {
  connection: LenientMcpConnection;
  listPrompts: ReturnType<typeof vi.fn>;
  listResources: ReturnType<typeof vi.fn>;
  listResourceTemplates: ReturnType<typeof vi.fn>;
} {
  const listPrompts = vi.fn(async () => {
    throw new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: prompts/list"},"id":6}',
    );
  });
  const listResources = vi.fn(async () => ({ resources: [{ uri: "file:///ignored" }] }));
  const listResourceTemplates = vi.fn(async () => ({ resourceTemplates: [{ uriTemplate: "file:///{path}" }] }));
  const client = {
    getInstructions: vi.fn(() => "Use these tools."),
    getServerCapabilities: vi.fn(() => ({
      tools: {},
      resources: {},
      prompts: {},
    })),
    listTools: vi.fn(async () => ({
      tools: [{
        name: "search",
        description: "Search TinyFish",
        inputSchema: { type: "object" },
      }],
    })),
    listResources,
    listResourceTemplates,
    listPrompts,
  } as LenientMcpConnection["client"] & {
    listPrompts: typeof listPrompts;
    listResources: typeof listResources;
    listResourceTemplates: typeof listResourceTemplates;
  };
  return {
    connection: {
      client,
      connectionError: null,
      connectionState: "connected",
      prompts: [],
      resourceTemplates: [],
      resources: [],
      tools: [],
    },
    listPrompts,
    listResources,
    listResourceTemplates,
  };
}

describe("lenient MCP discovery", () => {
  it("discovers tools without fetching non-tool capabilities", async () => {
    const { connection, listPrompts, listResources, listResourceTemplates } = makeConnection();

    const result = await discoverMcpCapabilitiesLenient(connection);

    expect(result).toEqual({ success: true, state: "ready" });
    expect(connection.connectionState).toBe("ready");
    expect(connection.connectionError).toBeNull();
    expect(connection.instructions).toBe("Use these tools.");
    expect(connection.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(connection.resources).toEqual([]);
    expect(connection.resourceTemplates).toEqual([]);
    expect(connection.prompts).toEqual([]);
    expect(listResources).not.toHaveBeenCalled();
    expect(listResourceTemplates).not.toHaveBeenCalled();
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("refreshes tools from tool-list change notifications", async () => {
    const { connection, listPrompts, listResources, listResourceTemplates } = makeConnection();
    let notificationHandler: ((notification: unknown) => void | Promise<void>) | undefined;
    let toolListCallCount = 0;
    connection.client.getServerCapabilities = vi.fn(() => ({
      tools: { listChanged: true },
      resources: {},
      prompts: {},
    }));
    connection.client.listTools = vi.fn(async () => {
      toolListCallCount += 1;
      return {
        tools: [{
          name: toolListCallCount === 1 ? "search" : "browse",
          description: "Dynamic tool",
          inputSchema: { type: "object" },
        }],
      };
    });
    connection.client.setNotificationHandler = vi.fn((_schema, handler) => {
      notificationHandler = handler;
    });

    await discoverMcpCapabilitiesLenient(connection);

    expect(connection.client.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["search"]);

    await notificationHandler?.({ method: "notifications/tools/list_changed" });

    expect(connection.tools.map((tool) => tool.name)).toEqual(["browse"]);
    expect(connection.connectionError).toBeNull();
    expect(connection.client.listTools).toHaveBeenCalledTimes(2);
    expect(listResources).not.toHaveBeenCalled();
    expect(listResourceTemplates).not.toHaveBeenCalled();
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("bounds tool discovery with a timeout", async () => {
    vi.useFakeTimers();
    try {
      const { connection } = makeConnection();
      connection.client.listTools = vi.fn(() => new Promise<never>(() => undefined));

      const discovery = discoverMcpCapabilitiesLenient(connection, { timeoutMs: 25 });

      await vi.advanceTimersByTimeAsync(25);
      await expect(discovery).resolves.toEqual({
        success: false,
        state: "connected",
        error: "Discovery timed out after 25ms",
      });
      expect(connection.connectionState).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats bare JSON-RPC method-not-found list errors as optional", async () => {
    const { connection } = makeConnection();
    connection.client.listTools = vi.fn(async () => {
      throw { code: -32601, message: "Method not found" };
    });

    const result = await discoverMcpCapabilitiesLenient(connection);

    expect(result).toEqual({ success: true, state: "ready" });
    expect(connection.tools).toEqual([]);
    expect(connection.connectionError).toBeNull();
  });

  it("recognizes Streamable HTTP method-not-found wrapper errors", () => {
    expect(isOptionalMcpListMethodNotFound(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: prompts/list"},"id":6}',
    )).toBe(true);
    expect(isOptionalMcpListMethodNotFound({
      code: -32601,
      message: "Method not found: prompts/list",
    })).toBe(true);
    expect(isOptionalMcpListMethodNotFound({
      code: -32601,
      message: "Method not found",
    })).toBe(true);
    expect(isOptionalMcpListMethodNotFound("Discovery timed out after 30000ms")).toBe(false);
  });
});
