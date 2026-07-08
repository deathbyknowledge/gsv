import { describe, expect, it, vi } from "vitest";
import { __DO_NOT_USE_WILL_BREAK__agentContext } from "agents";
import { Kernel } from "./do";

describe("Kernel device connection cleanup", () => {
  it("closes live driver connections when a machine is forgotten", () => {
    const alpha = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-alpha" },
      },
      close: vi.fn(),
    };
    const beta = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-beta" },
      },
      close: vi.fn(),
    };
    const user = {
      state: {
        step: "connected",
        identity: { role: "user" },
      },
      close: vi.fn(),
    };
    const kernel = Object.create(Kernel.prototype) as {
      connections: Map<string, unknown>;
      disconnectDeviceConnections(deviceId: string, reason: string): void;
      failRoutesForDevice: ReturnType<typeof vi.fn>;
      runRoutes: {
        clearForConnection: ReturnType<typeof vi.fn>;
      };
    };
    kernel.connections = new Map([
      ["alpha", alpha],
      ["beta", beta],
      ["user", user],
    ]);
    kernel.failRoutesForDevice = vi.fn();
    kernel.runRoutes = {
      clearForConnection: vi.fn(),
    };

    kernel.disconnectDeviceConnections("node-alpha", "Machine forgotten");

    expect(alpha.close).toHaveBeenCalledWith(1000, "Machine forgotten");
    expect(beta.close).not.toHaveBeenCalled();
    expect(user.close).not.toHaveBeenCalled();
    expect(kernel.connections.has("alpha")).toBe(false);
    expect(kernel.connections.has("beta")).toBe(true);
    expect(kernel.connections.has("user")).toBe(true);
    expect(kernel.runRoutes.clearForConnection).toHaveBeenCalledWith("alpha");
    expect(kernel.failRoutesForDevice).toHaveBeenCalledWith("node-alpha");
  });
});

describe("Kernel MCP connection cleanup", () => {
  it("removes newly registered MCP servers when the initial connection fails", async () => {
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        transport: { type: "auto" };
      }): Promise<unknown>;
      mcp: {
        listServers: ReturnType<typeof vi.fn>;
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
      mcpDiscoveryTasks: Map<string, Promise<unknown>>;
      removeMcpServer: ReturnType<typeof vi.fn>;
    };
    kernel.mcp = {
      listServers: vi.fn(() => []),
      registerServer: vi.fn(async () => undefined),
      connectToServer: vi.fn(async (serverId: string) => {
        kernel.mcpDiscoveryTasks.set(serverId, Promise.resolve(undefined));
        return {
          state: "failed",
          error: "connection rejected",
        };
      }),
    };
    kernel.mcpDiscoveryTasks = new Map();
    kernel.removeMcpServer = vi.fn(async () => undefined);
    const expectedError =
      "Failed to connect to MCP server at https://tinyfish.example/mcp: connection rejected";

    await expect(
      kernel.addMcpServerConnection({
        uid: 1000,
        name: "TinyFish",
        url: "https://tinyfish.example/mcp",
        transport: { type: "auto" },
      }),
    ).rejects.toThrow(expectedError);

    const serverId = kernel.mcp.registerServer.mock.calls[0][0];
    expect(kernel.removeMcpServer).toHaveBeenCalledWith(serverId);
    expect(kernel.mcpDiscoveryTasks.has(serverId)).toBe(false);
  });

  it("does not share discovery errors across duplicate MCP endpoint URLs", () => {
    const kernel = Object.create(Kernel.prototype) as {
      recordMcpDiscoveryEvent(event: { type: string; payload?: unknown }): void;
      broadcastMcpChanged: ReturnType<typeof vi.fn>;
      mcp: {
        mcpConnections: Record<string, {
          url?: URL;
          connectionError?: string | null;
        }>;
      };
    };
    const sharedUrl = "https://tinyfish.example/mcp";
    kernel.mcp = {
      mcpConnections: {
        "server-a": {
          url: new URL(sharedUrl),
          connectionError: null,
        },
        "server-b": {
          url: new URL(sharedUrl),
          connectionError: "existing error",
        },
      },
    };
    kernel.broadcastMcpChanged = vi.fn();

    kernel.recordMcpDiscoveryEvent({
      type: "mcp:client:discover",
      payload: {
        url: sharedUrl,
        error: "tools/list failed",
      },
    });

    expect(kernel.mcp.mcpConnections["server-a"].connectionError).toBeNull();
    expect(kernel.mcp.mcpConnections["server-b"].connectionError).toBe("existing error");
    expect(kernel.broadcastMcpChanged).not.toHaveBeenCalled();
  });

  it("stores custom MCP headers in durable transport options", async () => {
    type RegisteredServerOptions = {
      transport: {
        eventSourceInit?: {
          fetch?: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
        };
        headers?: Record<string, string>;
        requestInit?: {
          headers?: Record<string, string>;
        };
      };
    };
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        transport: {
          type: "sse";
          headers: Record<string, string>;
        };
      }): Promise<unknown>;
      mcp: {
        listServers: ReturnType<typeof vi.fn>;
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
    };
    let registeredOptions: RegisteredServerOptions | null = null;
    kernel.mcp = {
      listServers: vi.fn(() => []),
      registerServer: vi.fn(async (_serverId: string, options: RegisteredServerOptions) => {
        registeredOptions = options;
      }),
      connectToServer: vi.fn(async () => ({
        state: "authenticating",
        authUrl: "https://tinyfish.example/oauth",
      })),
    };

    await kernel.addMcpServerConnection({
      uid: 1000,
      name: "TinyFish",
      url: "https://tinyfish.example/mcp",
      transport: {
        type: "sse",
        headers: {
          Authorization: "Bearer user-token",
          "X-API-Key": "custom-key",
        },
      },
    });

    expect(registeredOptions?.transport.eventSourceInit?.fetch).toEqual(expect.any(Function));
    expect(registeredOptions?.transport.headers).toEqual({
      Authorization: "Bearer user-token",
      "X-API-Key": "custom-key",
    });
    expect(registeredOptions?.transport.requestInit?.headers).toEqual({
      Authorization: "Bearer user-token",
      "X-API-Key": "custom-key",
    });

    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await registeredOptions?.transport.eventSourceInit?.fetch?.("https://tinyfish.example/sse", {
        headers: {
          Accept: "text/event-stream",
          "Mcp-Protocol-Version": "2025-06-18",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const sseInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const sseHeaders = new Headers(sseInit?.headers);
    expect(sseHeaders.get("Accept")).toBe("text/event-stream");
    expect(sseHeaders.get("Mcp-Protocol-Version")).toBe("2025-06-18");
    expect(sseHeaders.get("Authorization")).toBe("Bearer user-token");
    expect(sseHeaders.get("X-API-Key")).toBe("custom-key");

    expect(JSON.parse(JSON.stringify(registeredOptions?.transport))).toEqual({
      eventSourceInit: {},
      headers: {
        Authorization: "Bearer user-token",
        "X-API-Key": "custom-key",
      },
      requestInit: {
        headers: {
          Authorization: "Bearer user-token",
          "X-API-Key": "custom-key",
        },
      },
      type: "sse",
    });
  });

  it("derives the MCP OAuth callback host from the active connection", async () => {
    type RegisteredServerOptions = {
      callbackUrl?: string;
      transport: {
        authProvider?: unknown;
      };
    };
    const kernel = Object.create(Kernel.prototype) as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        transport: { type: "auto" };
      }): Promise<unknown>;
      createMcpOAuthProvider: ReturnType<typeof vi.fn>;
      mcp: {
        listServers: ReturnType<typeof vi.fn>;
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
    };
    let registeredOptions: RegisteredServerOptions | null = null;
    const authProvider = { provider: "oauth" };
    kernel.createMcpOAuthProvider = vi.fn(() => authProvider);
    kernel.mcp = {
      listServers: vi.fn(() => []),
      registerServer: vi.fn(async (_serverId: string, options: RegisteredServerOptions) => {
        registeredOptions = options;
      }),
      connectToServer: vi.fn(async () => ({
        state: "authenticating",
        authUrl: "https://tinyfish.example/oauth",
      })),
    };

    await __DO_NOT_USE_WILL_BREAK__agentContext.run({
      agent: kernel,
      connection: {
        uri: "https://gsv.example.com/agents/kernel/user?_pk=conn",
      } as never,
      request: undefined,
      email: undefined,
    }, async () => {
      await kernel.addMcpServerConnection({
        uid: 1000,
        name: "TinyFish",
        url: "https://tinyfish.example/mcp",
        transport: { type: "auto" },
      });
    });

    expect(kernel.createMcpOAuthProvider).toHaveBeenCalledWith(
      "https://gsv.example.com/oauth/callback",
    );
    expect(registeredOptions?.callbackUrl).toBe("https://gsv.example.com/oauth/callback");
    expect(registeredOptions?.transport.authProvider).toBe(authProvider);
  });
});

describe("Kernel CLI download refresh coordination", () => {
  it("runs explicit refreshes after an in-flight automatic refresh", async () => {
    const kernel = Object.create(Kernel.prototype) as {
      cliDownloadsRefresh: Promise<void> | null;
      withCliDownloadsRefreshSlot<T>(
        run: () => Promise<T>,
        options?: { waitForExisting?: boolean },
      ): Promise<T>;
    };
    kernel.cliDownloadsRefresh = null;
    const order: string[] = [];
    let releaseAutoRefresh: () => void = () => {};

    const automaticRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      order.push("auto:start");
      await new Promise<void>((resolve) => {
        releaseAutoRefresh = resolve;
      });
      order.push("auto:end");
    });

    let explicitStarted = false;
    const explicitRefresh = kernel.withCliDownloadsRefreshSlot(async () => {
      explicitStarted = true;
      order.push("explicit");
      return "updated";
    }, { waitForExisting: true });

    await Promise.resolve();
    expect(explicitStarted).toBe(false);

    releaseAutoRefresh();

    await expect(explicitRefresh).resolves.toBe("updated");
    await automaticRefresh;
    expect(order).toEqual(["auto:start", "auto:end", "explicit"]);
  });
});

describe("Kernel process device requests", () => {
  function buildKernelForDeviceRequest(options: {
    capabilities?: string[];
    implements?: string[];
  } = {}) {
    const device = {
      device_id: "linux-machine",
      owner_uid: 0,
      label: "Linux machine",
      description: "",
      implements: options.implements ?? ["net.fetch"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1,
      last_seen_at: 2,
      connected_at: 2,
      disconnected_at: null,
    };
    const requestDevice = vi.fn(async () => ({
      ok: true,
      url: "https://example.com",
      status: 204,
      statusText: "No Content",
      headers: {},
      bodyBase64: "",
      bodyBytes: 0,
    }));
    const kernel = Object.create(Kernel.prototype) as {
      ready: Promise<void>;
      env: Record<string, never>;
      procs: { getIdentity: ReturnType<typeof vi.fn> };
      caps: { resolve: ReturnType<typeof vi.fn> };
      devices: {
        canAccess: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
      };
      requestDevice: typeof requestDevice;
      requestProcessNetFetch(
        processId: string,
        target: string,
        args: { url: string; timeoutMs: number },
        options?: { ttlMs?: number; internalPurpose?: "model-transport" },
      ): Promise<unknown>;
    };
    kernel.ready = Promise.resolve();
    kernel.env = {};
    kernel.procs = { getIdentity: vi.fn(() => ({
      uid: 0,
      gid: 0,
      gids: [0],
      username: "root",
      home: "/root",
      cwd: "/root",
    })) };
    kernel.caps = { resolve: vi.fn(() => options.capabilities ?? ["net.fetch"]) };
    kernel.devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => device),
    };
    kernel.requestDevice = requestDevice;
    return { kernel, requestDevice };
  }

  it("validates the process target and calls requestDevice", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(kernel.procs.getIdentity).toHaveBeenCalledWith("proc_1");
    expect(kernel.devices.canAccess).toHaveBeenCalledWith("linux-machine", 0, [0]);
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      180000,
    );
  });

  it("requires net.fetch capability for default process net fetches", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });

    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    )).rejects.toThrow("Permission denied: net.fetch");

    expect(requestDevice).not.toHaveBeenCalled();
  });

  it("allows internal model transport net fetches without tool capability", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000, internalPurpose: "model-transport" },
    );

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      180000,
    );
  });
});
