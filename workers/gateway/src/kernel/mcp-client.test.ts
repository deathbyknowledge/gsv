import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlockedUrl,
  isMethodNotFound,
  McpClientConnection,
  McpClientManager,
  type McpClientTransport,
  type McpConnection,
  type McpServerRow,
  type McpServerRows,
  type McpTransportOptions,
} from "./mcp-client";
import { McpOAuthProvider, type OAuthKeyValueStorage } from "./mcp-oauth-provider";

const CALLBACK_URL = "https://gsv.example/oauth/callback";

class FakeRows implements McpServerRows {
  readonly rows = new Map<string, McpServerRow>();

  list(): McpServerRow[] {
    return [...this.rows.values()];
  }

  get(id: string): McpServerRow | undefined {
    return this.rows.get(id);
  }

  save(row: McpServerRow): void {
    this.rows.set(row.id, row);
  }

  remove(id: string): void {
    this.rows.delete(id);
  }
}

class FakeStorage implements OAuthKeyValueStorage {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: the fake stores exactly the values the provider put under each key.
    return this.entries.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(keys: string | string[]): Promise<number> {
    let removed = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.entries.delete(key)) removed += 1;
    }
    return removed;
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    for (const [key, value] of this.entries) {
      if (!key.startsWith(options.prefix)) continue;
      // SAFETY: the fake stores exactly the values the provider put under each key.
      found.set(key, value as T);
    }
    return found;
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }
}

type FakeConnection = McpConnection & {
  init: ReturnType<typeof vi.fn>;
  discover: ReturnType<typeof vi.fn>;
  completeAuthorization: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
};

function fakeConnection(url: URL, transport: McpTransportOptions): FakeConnection {
  const connection: FakeConnection = {
    url,
    options: { transport },
    connectionState: "connecting",
    connectionError: null,
    tools: [],
    resources: [],
    prompts: [],
    resourceTemplates: [],
    sessionId: undefined,
    init: vi.fn(async () => {
      connection.connectionState = "connected";
      return undefined;
    }),
    completeAuthorization: vi.fn(async () => undefined),
    discover: vi.fn(async () => {
      connection.connectionState = "ready";
      return { success: true };
    }),
    cancelDiscovery: vi.fn(),
    close: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
  return connection;
}

function makeManager(setup: Record<string, (connection: FakeConnection) => void> = {}) {
  const rows = new FakeRows();
  const storage = new FakeStorage();
  const connections = new Map<string, FakeConnection>();
  const waitUntil = vi.fn();
  const manager = new McpClientManager({ name: "GSV Kernel", version: "0.0.0" }, {
    rows,
    retryBackoffMs: 0,
    waitUntil,
    createAuthProvider: (callbackUrl) => new McpOAuthProvider(storage, "install-1", callbackUrl),
    createConnection: (url, _info, options) => {
      const connection = fakeConnection(url, options.transport);
      setup[url.href]?.(connection);
      connections.set(url.href, connection);
      return connection;
    },
  });
  return { manager, rows, storage, connections, waitUntil };
}

/** An in-memory MCP server transport that fails to start, or answers `initialize`. */
class StubTransport implements McpClientTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly finishAuth = vi.fn(async () => undefined);

  constructor(private readonly startError?: Error) {}

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message) || message.method !== "initialize" || !("id" in message)) return;
    const response: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0" },
      },
    };
    queueMicrotask(() => this.onmessage?.(response));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Put a server into the authenticating state with a pending PKCE flow. */
async function startAuthorization(input: {
  manager: McpClientManager;
  storage: FakeStorage;
  serverId: string;
  connection: FakeConnection;
}): Promise<{ provider: McpOAuthProvider; state: string }> {
  const provider = new McpOAuthProvider(input.storage, "install-1", CALLBACK_URL);
  provider.serverId = input.serverId;
  provider.clientId = "client-1";
  input.connection.options.transport.authProvider = provider;
  const state = await provider.state();
  await provider.saveCodeVerifier("verifier-1");
  const authorize = new URL("https://idp.example/authorize");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await sha256Base64Url("verifier-1"));
  await provider.redirectToAuthorization(authorize);
  input.connection.init.mockImplementation(async () => {
    input.connection.connectionState = "authenticating";
    return undefined;
  });
  return { provider, state };
}

describe("McpClientManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists a registered server and forgets it on removal", async () => {
    const { manager, rows, connections } = makeManager();
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "u1000:tools",
      callbackUrl: CALLBACK_URL,
      transport: { type: "sse", requestInit: { headers: { "X-API-Key": "secret" } } },
    });

    expect(manager.listServers()).toEqual([{
      id: "mcp-1",
      name: "u1000:tools",
      server_url: "https://tools.example/mcp",
      client_id: null,
      auth_url: null,
      callback_url: CALLBACK_URL,
      server_options: JSON.stringify({
        transport: { type: "sse", requestInit: { headers: { "x-api-key": "secret" } } },
      }),
    }]);

    await manager.removeServer("mcp-1");
    expect(rows.list()).toEqual([]);
    expect(connections.get("https://tools.example/mcp")?.close).toHaveBeenCalledTimes(1);
    expect(manager.mcpConnections["mcp-1"]).toBeUndefined();
  });

  it("refuses private and unspecified addresses", async () => {
    const { manager } = makeManager();
    await expect(manager.registerServer("mcp-1", {
      url: "http://10.1.2.3/mcp",
      name: "internal",
      transport: { type: "auto" },
    })).rejects.toThrow("Blocked URL");
    expect(isBlockedUrl("http://[::ffff:192.168.0.1]/mcp")).toBe(true);
    expect(isBlockedUrl("http://0.0.0.0/mcp")).toBe(true);
    expect(isBlockedUrl("http://localhost:3000/mcp")).toBe(false);
    expect(isBlockedUrl("https://tools.example/mcp")).toBe(false);
  });

  it("reports connection failures and stores the pending authorization", async () => {
    const { manager, storage, connections } = makeManager();
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "tools",
      callbackUrl: CALLBACK_URL,
      transport: { type: "auto" },
    });
    const connection = connections.get("https://tools.example/mcp");
    if (!connection) throw new Error("connection missing");

    connection.init.mockImplementationOnce(async () => {
      connection.connectionState = "failed";
      return "connection rejected";
    });
    await expect(manager.connectToServer("mcp-1")).resolves.toEqual({
      state: "failed",
      error: "connection rejected",
    });

    await startAuthorization({ manager, storage, serverId: "mcp-1", connection });
    const result = await manager.connectToServer("mcp-1");
    expect(result.state).toBe("authenticating");
    if (result.state !== "authenticating") throw new Error("expected authenticating");
    expect(result.authUrl).toMatch(/^https:\/\/idp\.example\/authorize\?state=/);
    expect(result.clientId).toBe("client-1");
    expect(manager.listServers()[0]).toMatchObject({
      auth_url: result.authUrl,
      client_id: "client-1",
    });
  });

  it("finishes authorization from the callback with that flow's code verifier", async () => {
    const { manager, storage, connections } = makeManager();
    const changes = vi.fn();
    manager.onServerStateChanged(changes);
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "tools",
      callbackUrl: CALLBACK_URL,
      transport: { type: "streamable-http" },
    });
    const connection = connections.get("https://tools.example/mcp");
    if (!connection) throw new Error("connection missing");
    const { provider, state } = await startAuthorization({
      manager,
      storage,
      serverId: "mcp-1",
      connection,
    });
    await manager.connectToServer("mcp-1");
    let servedVerifier: string | null = null;
    connection.completeAuthorization.mockImplementation(async () => {
      servedVerifier = await provider.codeVerifier();
    });

    const callback = new Request(`${CALLBACK_URL}?code=code-1&state=${encodeURIComponent(state)}`);
    expect(manager.isCallbackRequest(callback)).toBe(true);
    expect(manager.isCallbackRequest(new Request(`https://other.example/oauth/callback?state=${state}`)))
      .toBe(false);
    const result = await manager.handleCallbackRequest(callback);

    expect(result).toEqual({ serverId: "mcp-1", authSuccess: true });
    expect(connection.completeAuthorization).toHaveBeenCalledWith("code-1");
    expect(servedVerifier).toBe("verifier-1");
    expect(connection.connectionState).toBe("connecting");
    expect(manager.listServers()[0]?.auth_url).toBeNull();
    expect(storage.keys().filter((key) => key.includes("code_verifier"))).toEqual([]);
    expect(storage.keys().filter((key) => key.includes("/state/"))).toEqual([]);
    expect(changes).toHaveBeenCalled();
  });

  it("treats a stale callback on an accepted session as already authorized", async () => {
    const { manager, storage, connections } = makeManager();
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "tools",
      callbackUrl: CALLBACK_URL,
      transport: { type: "auto" },
    });
    const connection = connections.get("https://tools.example/mcp");
    if (!connection) throw new Error("connection missing");
    const provider = new McpOAuthProvider(storage, "install-1", CALLBACK_URL);
    provider.serverId = "mcp-1";
    connection.options.transport.authProvider = provider;
    connection.connectionState = "ready";
    connection.connectionError = "old failure";

    const result = await manager.handleCallbackRequest(
      new Request(`${CALLBACK_URL}?code=late&state=unknown-nonce.mcp-1`),
    );

    expect(result).toEqual({ serverId: "mcp-1", authSuccess: true });
    expect(connection.completeAuthorization).not.toHaveBeenCalled();
    expect(connection.connectionError).toBeNull();
  });

  it("fails the session when the authorization server denies the flow", async () => {
    const { manager, storage, connections } = makeManager();
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "tools",
      callbackUrl: CALLBACK_URL,
      transport: { type: "auto" },
    });
    const connection = connections.get("https://tools.example/mcp");
    if (!connection) throw new Error("connection missing");
    const { state } = await startAuthorization({ manager, storage, serverId: "mcp-1", connection });
    await manager.connectToServer("mcp-1");

    const result = await manager.handleCallbackRequest(new Request(
      `${CALLBACK_URL}?error=access_denied&error_description=Denied+by+user&state=${encodeURIComponent(state)}`,
    ));

    expect(result).toEqual({ serverId: "mcp-1", authSuccess: false, authError: "Denied by user" });
    expect(connection.connectionState).toBe("failed");
    expect(connection.connectionError).toBe("Denied by user");
    expect(manager.listServers()[0]?.auth_url).toBeNull();
  });

  it("restores stored servers in the background and leaves pending authorizations alone", async () => {
    const { manager, rows, connections, waitUntil } = makeManager({
      "https://broken.example/mcp": (connection) => {
        connection.init.mockImplementation(async () => {
          throw new Error("socket hang up");
        });
      },
      "https://gone.example/mcp": (connection) => {
        connection.init.mockImplementation(async () => {
          connection.connectionState = "failed";
          return "HTTP 404 Not Found";
        });
      },
    });
    const changes = vi.fn();
    manager.onServerStateChanged(changes);
    rows.save({
      id: "mcp-gone",
      name: "gone",
      server_url: "https://gone.example/mcp",
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: null,
    });
    rows.save({
      id: "mcp-broken",
      name: "broken",
      server_url: "https://broken.example/mcp",
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: null,
    });
    rows.save({
      id: "mcp-ready",
      name: "ready",
      server_url: "https://ready.example/mcp",
      client_id: null,
      auth_url: null,
      callback_url: CALLBACK_URL,
      server_options: JSON.stringify({
        transport: { type: "sse", requestInit: { headers: { "x-api-key": "k" } }, sessionId: "s1" },
      }),
    });
    rows.save({
      id: "mcp-pending",
      name: "pending",
      server_url: "https://pending.example/mcp",
      client_id: "client-9",
      auth_url: "https://idp.example/authorize?state=n.mcp-pending",
      callback_url: CALLBACK_URL,
      server_options: null,
    });

    manager.restoreConnectionsFromStorage();

    const ready = connections.get("https://ready.example/mcp");
    const pending = connections.get("https://pending.example/mcp");
    const broken = connections.get("https://broken.example/mcp");
    const gone = connections.get("https://gone.example/mcp");
    expect(Object.keys(manager.mcpConnections).sort()).toEqual([
      "mcp-broken",
      "mcp-gone",
      "mcp-pending",
      "mcp-ready",
    ]);
    expect(ready?.discover).not.toHaveBeenCalled();
    expect(ready?.connectionState).not.toBe("ready");
    expect(waitUntil).toHaveBeenCalledTimes(3);
    expect(waitUntil.mock.calls.every(([task]) => task instanceof Promise)).toBe(true);

    await manager.whenIdle();

    expect(ready?.init).toHaveBeenCalledTimes(1);
    expect(ready?.discover).toHaveBeenCalledTimes(1);
    expect(ready?.connectionState).toBe("ready");
    expect(broken?.connectionState).toBe("failed");
    expect(broken?.connectionError).toBe("socket hang up");
    expect(gone?.init).toHaveBeenCalledTimes(1);
    expect(gone?.connectionState).toBe("failed");
    expect(gone?.connectionError).toBe("HTTP 404 Not Found");
    expect(changes).toHaveBeenCalled();
    expect(ready?.options.transport).toMatchObject({
      type: "sse",
      requestInit: { headers: { "x-api-key": "k" } },
      sessionId: "s1",
    });
    expect(ready?.options.transport.authProvider?.redirectUrl).toBe(CALLBACK_URL);
    expect(pending?.init).not.toHaveBeenCalled();
    expect(pending?.connectionState).toBe("authenticating");
    expect(pending?.options.transport.authProvider?.registeredClientId).toBe("client-9");
  });

  it("records discovery failures on the session and namespaces listings", async () => {
    const { manager, connections } = makeManager();
    await manager.registerServer("mcp-1", {
      url: "https://tools.example/mcp",
      name: "tools",
      transport: { type: "auto" },
    });
    const connection = connections.get("https://tools.example/mcp");
    if (!connection) throw new Error("connection missing");
    await manager.connectToServer("mcp-1");
    connection.discover.mockImplementationOnce(async () => {
      connection.connectionError = "Failed to discover MCP server capabilities: tools/list timed out";
      return { success: false, error: "tools/list timed out" };
    });

    await expect(manager.discoverIfConnected("mcp-1")).resolves.toEqual({
      success: false,
      error: "tools/list timed out",
      state: "connected",
    });
    expect(connection.connectionError).toContain("tools/list timed out");
    expect(await manager.discoverIfConnected("missing")).toBeUndefined();

    connection.tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    expect(manager.listTools({ serverId: "mcp-1" })).toEqual([
      { name: "lookup", inputSchema: { type: "object" }, serverId: "mcp-1" },
    ]);
    expect(manager.listTools({ serverId: "other" })).toEqual([]);

    const controller = new AbortController();
    await manager.callTool(
      { serverId: "mcp-1", name: "lookup", arguments: { query: "gsv" } },
      { signal: controller.signal },
    );
    expect(connection.callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { query: "gsv" } },
      { signal: controller.signal },
    );
    await expect(manager.callTool({ serverId: "missing", name: "lookup" }))
      .rejects.toThrow("MCP server missing is not connected");
  });
});

describe("McpClientManager reconnects", () => {
  it("retries transient failures after authorization but not final ones", async () => {
    const { manager, connections, waitUntil } = makeManager({
      "https://flaky.example/mcp": (connection) => {
        let attempts = 0;
        connection.init.mockImplementation(async () => {
          attempts += 1;
          if (attempts < 3) {
            connection.connectionState = "failed";
            return "socket hang up";
          }
          connection.connectionState = "connected";
          return undefined;
        });
      },
      "https://gone.example/mcp": (connection) => {
        connection.init.mockImplementation(async () => {
          connection.connectionState = "failed";
          return "HTTP 404 Not Found";
        });
      },
    });
    await manager.registerServer("mcp-flaky", {
      url: "https://flaky.example/mcp",
      name: "flaky",
      transport: { type: "streamable-http" },
    });
    await manager.registerServer("mcp-gone", {
      url: "https://gone.example/mcp",
      name: "gone",
      transport: { type: "streamable-http" },
    });

    await manager.establishConnection("mcp-flaky");
    await manager.establishConnection("mcp-gone");
    await manager.whenIdle();
    expect(waitUntil).toHaveBeenCalledTimes(2);

    const flaky = connections.get("https://flaky.example/mcp");
    const gone = connections.get("https://gone.example/mcp");
    expect(flaky?.init).toHaveBeenCalledTimes(3);
    expect(flaky?.discover).toHaveBeenCalledTimes(1);
    expect(flaky?.connectionState).toBe("ready");
    expect(gone?.init).toHaveBeenCalledTimes(1);
    expect(gone?.discover).not.toHaveBeenCalled();
    expect(gone?.connectionState).toBe("failed");
  });
});

describe("McpClientConnection transports", () => {
  it("reconnects after a probe failed inside the transport start", async () => {
    const created: string[] = [];
    const scripted = [
      new StubTransport(new Error("Streamable HTTP error: HTTP 404 Not Found")),
      new StubTransport(new UnauthorizedError("Unauthorized")),
    ];
    const connection = new McpClientConnection(
      new URL("https://tools.example/mcp"),
      { name: "GSV Kernel", version: "0.0.0" },
      {
        transport: { type: "auto" },
        createTransport: (kind) => {
          created.push(kind);
          return scripted.shift() ?? new StubTransport();
        },
      },
    );

    await expect(connection.init()).resolves.toBeUndefined();
    expect(connection.connectionState).toBe("authenticating");

    await connection.completeAuthorization("code-1");
    await expect(connection.init()).resolves.toBeUndefined();

    expect(connection.connectionState).toBe("connected");
    expect(connection.client.getServerCapabilities()).toEqual({ tools: {} });
    expect(created).toEqual(["streamable-http", "sse", "streamable-http", "streamable-http"]);
    await connection.close();
  });
});

describe("McpClientConnection discovery", () => {
  it("treats method-not-found answers as absent capabilities, wrapped or native", async () => {
    const wrapped = new Error(
      'Streamable HTTP error: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":6}',
    );
    expect(isMethodNotFound(wrapped)).toBe(true);
    expect(isMethodNotFound(new McpError(ErrorCode.MethodNotFound, "Method not found"))).toBe(true);
    expect(isMethodNotFound(new Error("tools/list timed out"))).toBe(false);

    const connection = new McpClientConnection(
      new URL("https://tools.example/mcp"),
      { name: "GSV Kernel", version: "0.0.0" },
      { transport: { type: "auto" } },
    );
    connection.connectionState = "connected";
    vi.spyOn(connection.client, "getServerCapabilities").mockReturnValue({ tools: {}, prompts: {} });
    vi.spyOn(connection.client, "getInstructions").mockReturnValue("Be brief.");
    vi.spyOn(connection.client, "listTools").mockResolvedValue({
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    });
    const listPrompts = vi.spyOn(connection.client, "listPrompts").mockRejectedValue(wrapped);

    await expect(connection.discover()).resolves.toEqual({ success: true });
    expect(connection.connectionState).toBe("ready");
    expect(connection.connectionError).toBeNull();
    expect(connection.instructions).toBe("Be brief.");
    expect(connection.tools.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(connection.prompts).toEqual([]);
    expect(listPrompts).toHaveBeenCalledTimes(1);

    vi.spyOn(connection.client, "listTools").mockRejectedValue(new Error("tools/list timed out"));
    await expect(connection.discover()).resolves.toEqual({
      success: false,
      error: "tools/list timed out",
    });
    expect(connection.connectionState).toBe("connected");
    expect(connection.connectionError).toBe(
      "Failed to discover MCP server capabilities: tools/list timed out",
    );
  });

  it("aborts list requests on timeout and ignores their late answers", async () => {
    const connection = new McpClientConnection(
      new URL("https://tools.example/mcp"),
      { name: "GSV Kernel", version: "0.0.0" },
      { transport: { type: "auto" } },
    );
    connection.connectionState = "connected";
    connection.tools = [{ name: "stable", inputSchema: { type: "object" } }];
    vi.spyOn(connection.client, "getServerCapabilities").mockReturnValue({ tools: {} });
    vi.spyOn(connection.client, "getInstructions").mockReturnValue(undefined);
    const listTools = vi.spyOn(connection.client, "listTools").mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({ tools: [{ name: "late", inputSchema: { type: "object" } }] }), 30);
      }),
    );

    await expect(connection.discover({ timeoutMs: 5 })).resolves.toEqual({
      success: false,
      error: "Discovery timed out after 5ms",
    });
    expect(connection.connectionState).toBe("connected");
    expect(listTools.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connection.tools.map((tool) => tool.name)).toEqual(["stable"]);
    expect(connection.serverCapabilities).toBeUndefined();
  });
});

describe("McpOAuthProvider", () => {
  it("keeps the storage layout the Agents SDK provider used", async () => {
    const storage = new FakeStorage();
    const provider = new McpOAuthProvider(storage, "install-1", CALLBACK_URL);
    provider.serverId = "mcp-1";
    await provider.saveClientInformation({ client_id: "client-1" });
    await provider.saveTokens({ access_token: "token", token_type: "bearer" });
    const state = await provider.state();
    await provider.saveCodeVerifier("verifier-1");
    const authorize = new URL("https://idp.example/authorize");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", await sha256Base64Url("verifier-1"));
    await provider.redirectToAuthorization(authorize);
    const nonce = state.split(".")[0];

    expect(storage.keys()).toEqual([
      "/install-1/mcp-1/client-1/client_info/",
      `/install-1/mcp-1/client-1/code_verifier/${nonce}`,
      "/install-1/mcp-1/client-1/token",
      `/install-1/mcp-1/state/${nonce}`,
    ].sort());
    expect(provider.authUrl).toBe(authorize.toString());
    expect(provider.clientMetadata).toMatchObject({
      client_name: "install-1",
      redirect_uris: [CALLBACK_URL],
      token_endpoint_auth_method: "none",
    });
    await expect(provider.clientInformation()).resolves.toEqual({ client_id: "client-1" });
    await expect(provider.tokens()).resolves.toEqual({ access_token: "token", token_type: "bearer" });
  });

  it("validates states and serves the verifier of the callback's flow", async () => {
    const storage = new FakeStorage();
    const provider = new McpOAuthProvider(storage, "install-1", CALLBACK_URL);
    provider.serverId = "mcp-1";
    provider.clientId = "client-1";
    const state = await provider.state();
    await expect(provider.checkState("garbage")).resolves.toEqual({
      valid: false,
      error: "Invalid state format",
    });
    await expect(provider.checkState("nonce.mcp-1")).resolves.toEqual({
      valid: false,
      error: "State not found or already used",
    });
    await expect(provider.checkState(state)).resolves.toEqual({ valid: true, serverId: "mcp-1" });

    await provider.saveCodeVerifier("verifier-1");
    const authorize = new URL("https://idp.example/authorize");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", await sha256Base64Url("verifier-1"));
    await provider.redirectToAuthorization(authorize);

    await provider.withCallbackState(state, async () => {
      await expect(provider.codeVerifier()).resolves.toBe("verifier-1");
      await provider.deleteCodeVerifier();
    });
    expect(storage.keys().filter((key) => key.includes("code_verifier"))).toEqual([]);
    await expect(provider.withCallbackState(state, () => provider.codeVerifier()))
      .rejects.toThrow("No code verifier found for OAuth state");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    await expect(provider.checkState(state)).resolves.toEqual({
      valid: false,
      error: "State expired",
    });
    vi.restoreAllMocks();
  });
});
