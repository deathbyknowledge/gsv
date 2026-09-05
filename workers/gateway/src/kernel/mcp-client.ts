import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  ErrorCode,
  McpError,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Implementation,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { McpOAuthProvider, parseOAuthState } from "./mcp-oauth-provider";

/**
 * MCP client sessions owned by the Kernel: one `Client` from the MCP SDK per
 * registered server, the server rows in the Kernel's SQLite, and the OAuth
 * callback that finishes a server's authorization. Rows stay in the
 * `cf_agents_mcp_servers` table with the columns the Agents SDK used, so
 * servers registered before the swap keep working.
 */

export type McpConnectionState =
  | "authenticating"
  | "connecting"
  | "connected"
  | "discovering"
  | "ready"
  | "failed";

export type McpTransportType = "auto" | "streamable-http" | "sse";

export type McpTransportOptions = {
  type: McpTransportType;
  authProvider?: McpOAuthProvider;
  requestInit?: RequestInit;
  sessionId?: string;
};

export type McpServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

export type McpRegisterServerOptions = {
  url: string;
  name: string;
  callbackUrl?: string;
  transport: McpTransportOptions;
};

export type McpConnectionResult =
  | { state: "connected" }
  | { state: "authenticating"; authUrl: string; clientId?: string }
  | { state: "failed"; error: string };

export type McpDiscoveryResult = {
  success: boolean;
  error?: string;
  state: McpConnectionState;
};

export type McpCallbackResult =
  | { serverId: string; authSuccess: true }
  | { serverId?: string; authSuccess: false; authError: string };

export type McpToolCallParams = {
  name: string;
  arguments?: JsonObject;
};

export type McpToolCallOptions = {
  signal?: AbortSignal;
};

export type McpToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

type McpTransportProbe =
  | { state: "connected" }
  | { state: "authenticating" }
  | { state: "failed"; error: string };

/** One server session as the manager and the syscalls see it. */
export interface McpConnection {
  readonly url: URL;
  readonly options: { transport: McpTransportOptions };
  connectionState: McpConnectionState;
  connectionError: string | null;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  resourceTemplates: ResourceTemplate[];
  serverCapabilities?: ServerCapabilities;
  instructions?: string;
  readonly sessionId: string | undefined;
  init(): Promise<string | undefined>;
  completeAuthorization(code: string): Promise<void>;
  discover(options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string }>;
  cancelDiscovery(): void;
  close(): Promise<void>;
  callTool(params: McpToolCallParams, options?: McpToolCallOptions): Promise<McpToolCallResult>;
}

const DISCOVERY_TIMEOUT_MS = 15_000;

export class McpClientConnection implements McpConnection {
  readonly client: Client;
  connectionState: McpConnectionState = "connecting";
  connectionError: string | null = null;
  tools: Tool[] = [];
  resources: Resource[] = [];
  prompts: Prompt[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  serverCapabilities?: ServerCapabilities;
  instructions?: string;
  private transport?: StreamableHTTPClientTransport | SSEClientTransport;
  private discoveryAbort?: AbortController;
  private probingCapabilities = false;

  constructor(
    readonly url: URL,
    info: Implementation,
    readonly options: { transport: McpTransportOptions },
  ) {
    this.client = new Client(info, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  }

  get sessionId(): string | undefined {
    return this.transport instanceof StreamableHTTPClientTransport
      ? this.transport.sessionId
      : undefined;
  }

  /** Connect the transport. Returns the error message when the connection failed. */
  async init(): Promise<string | undefined> {
    const probe = await this.tryConnect(this.options.transport.type);
    this.connectionState = probe.state;
    return probe.state === "failed" ? probe.error : undefined;
  }

  async completeAuthorization(code: string): Promise<void> {
    try {
      await this.finishAuth(code);
    } catch (error) {
      this.connectionState = "failed";
      throw error;
    }
  }

  async discover(options: { timeoutMs?: number } = {}): Promise<{ success: boolean; error?: string }> {
    const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
    if (this.connectionState !== "connected" && this.connectionState !== "ready") {
      return {
        success: false,
        error: `Discovery skipped - connection in ${this.connectionState} state`,
      };
    }
    this.discoveryAbort?.abort();
    const abort = new AbortController();
    this.discoveryAbort = abort;
    this.connectionState = "discovering";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.discoverAndRegister(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Discovery timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("Discovery was cancelled")),
            { once: true },
          );
        }),
      ]);
      this.connectionState = "ready";
      this.connectionError = null;
      return { success: true };
    } catch (error) {
      this.connectionState = "connected";
      const message = errorMessage(error);
      this.connectionError = `Failed to discover MCP server capabilities: ${message}`;
      return { success: false, error: message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.discoveryAbort === abort) this.discoveryAbort = undefined;
    }
  }

  cancelDiscovery(): void {
    this.discoveryAbort?.abort();
    this.discoveryAbort = undefined;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
      await transport.terminateSession().catch(() => undefined);
    }
    await this.client.close();
  }

  callTool(params: McpToolCallParams, options?: McpToolCallOptions): Promise<McpToolCallResult> {
    return this.client.callTool(params, undefined, options);
  }

  private async tryConnect(type: McpTransportType): Promise<McpTransportProbe> {
    const candidates: Array<"streamable-http" | "sse"> =
      type === "auto" ? ["streamable-http", "sse"] : [type];
    for (const [index, candidate] of candidates.entries()) {
      const hasFallback = index < candidates.length - 1;
      const transport = this.createTransport(candidate);
      try {
        await this.client.connect(transport);
        this.transport = transport;
        return { state: "connected" };
      } catch (error) {
        if (isUnauthorized(error)) return { state: "authenticating" };
        if (hasFallback && isTransportNotImplemented(error)) continue;
        return { state: "failed", error: errorMessage(error) };
      }
    }
    return { state: "failed", error: "No transports available" };
  }

  private async finishAuth(code: string): Promise<void> {
    const type = this.options.transport.type;
    const finish = async (candidate: "streamable-http" | "sse") => {
      await this.createTransport(candidate).finishAuth(code);
    };
    if (type !== "auto") {
      await finish(type);
      return;
    }
    try {
      await finish("streamable-http");
    } catch (error) {
      if (!isTransportNotImplemented(error)) throw error;
      await finish("sse");
    }
  }

  private createTransport(
    type: "streamable-http" | "sse",
  ): StreamableHTTPClientTransport | SSEClientTransport {
    const { authProvider, requestInit, sessionId } = this.options.transport;
    if (type === "streamable-http") {
      return new StreamableHTTPClientTransport(this.url, { authProvider, requestInit, sessionId });
    }
    return new SSEClientTransport(this.url, { authProvider, requestInit });
  }

  private async discoverAndRegister(): Promise<void> {
    const capabilities = this.client.getServerCapabilities();
    const resumed = this.transport instanceof StreamableHTTPClientTransport
      && this.transport.sessionId !== undefined;
    const probe = !capabilities && resumed;
    this.serverCapabilities = capabilities;
    this.probingCapabilities = probe;
    if (!capabilities && !probe) {
      throw new Error("The MCP Server failed to return server capabilities");
    }
    const [tools, resources, prompts, resourceTemplates] = await Promise.all([
      capabilities?.tools || probe ? this.registerTools() : Promise.resolve([]),
      capabilities?.resources || probe ? this.registerResources() : Promise.resolve([]),
      capabilities?.prompts || probe ? this.registerPrompts() : Promise.resolve([]),
      capabilities?.resources || probe ? this.fetchResourceTemplates() : Promise.resolve([]),
    ]);
    this.instructions = this.client.getInstructions();
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.resourceTemplates = resourceTemplates;
  }

  private async registerTools(): Promise<Tool[]> {
    if (this.serverCapabilities?.tools?.listChanged || this.probingCapabilities) {
      this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.tools = await this.fetchTools();
      });
    }
    return this.fetchTools();
  }

  private async registerResources(): Promise<Resource[]> {
    if (this.serverCapabilities?.resources?.listChanged || this.probingCapabilities) {
      this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        this.resources = await this.fetchResources();
      });
    }
    return this.fetchResources();
  }

  private async registerPrompts(): Promise<Prompt[]> {
    if (this.serverCapabilities?.prompts?.listChanged || this.probingCapabilities) {
      this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        this.prompts = await this.fetchPrompts();
      });
    }
    return this.fetchPrompts();
  }

  private fetchTools(): Promise<Tool[]> {
    return this.fetchPages(async (cursor) => {
      const page = await this.client.listTools({ cursor });
      return { items: page.tools, nextCursor: page.nextCursor };
    });
  }

  private fetchResources(): Promise<Resource[]> {
    return this.fetchPages(async (cursor) => {
      const page = await this.client.listResources({ cursor });
      return { items: page.resources, nextCursor: page.nextCursor };
    });
  }

  private fetchPrompts(): Promise<Prompt[]> {
    return this.fetchPages(async (cursor) => {
      const page = await this.client.listPrompts({ cursor });
      return { items: page.prompts, nextCursor: page.nextCursor };
    });
  }

  private fetchResourceTemplates(): Promise<ResourceTemplate[]> {
    return this.fetchPages(async (cursor) => {
      const page = await this.client.listResourceTemplates({ cursor });
      return { items: page.resourceTemplates, nextCursor: page.nextCursor };
    });
  }

  /**
   * Walk a paginated list. A server that answers a list method with
   * "method not found" simply has none of that capability, whether it says so
   * with a JSON-RPC error or wraps that error in a transport failure.
   */
  private async fetchPages<T>(
    page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      let result: { items: T[]; nextCursor?: string };
      try {
        result = await page(cursor);
      } catch (error) {
        if (isMethodNotFound(error)) return items;
        throw error;
      }
      items.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    return items;
  }
}

export interface McpServerRows {
  list(): McpServerRow[];
  get(id: string): McpServerRow | undefined;
  save(row: McpServerRow): void;
  remove(id: string): void;
}

export class SqlMcpServerRows implements McpServerRows {
  constructor(private readonly sql: SqlStorage) {}

  list(): McpServerRow[] {
    return this.sql.exec<McpServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers",
    ).toArray();
  }

  get(id: string): McpServerRow | undefined {
    return this.sql.exec<McpServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers WHERE id = ?",
      id,
    ).toArray()[0];
  }

  save(row: McpServerRow): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.server_url,
      row.client_id,
      row.auth_url,
      row.callback_url,
      row.server_options,
    );
  }

  remove(id: string): void {
    this.sql.exec("DELETE FROM cf_agents_mcp_servers WHERE id = ?", id);
  }
}

type StoredTransportOptions = {
  type: McpTransportType;
  requestInit?: { headers?: Record<string, string> };
  sessionId?: string;
};

const storedServerOptionsSchema = z.object({
  transport: z.object({
    type: z.enum(["auto", "streamable-http", "sse"]).optional(),
    requestInit: z.object({ headers: z.record(z.string(), z.string()).optional() }).optional(),
    sessionId: z.string().optional(),
  }).optional(),
});

function parseStoredTransport(serverOptions: string | null): StoredTransportOptions {
  if (!serverOptions) return { type: "auto" };
  try {
    const parsed = storedServerOptionsSchema.safeParse(JSON.parse(serverOptions));
    if (!parsed.success) return { type: "auto" };
    const transport = parsed.data.transport;
    const stored: StoredTransportOptions = { type: transport?.type ?? "auto" };
    if (transport?.requestInit !== undefined) stored.requestInit = transport.requestInit;
    if (transport?.sessionId !== undefined) stored.sessionId = transport.sessionId;
    return stored;
  } catch {
    return { type: "auto" };
  }
}

function storedTransport(transport: McpTransportOptions): StoredTransportOptions {
  const stored: StoredTransportOptions = { type: transport.type };
  const headers = transport.requestInit?.headers;
  if (headers !== undefined) {
    stored.requestInit = { headers: Object.fromEntries(new Headers(headers).entries()) };
  }
  if (transport.sessionId !== undefined) stored.sessionId = transport.sessionId;
  return stored;
}

export type McpClientManagerOptions = {
  rows: McpServerRows;
  createAuthProvider: (callbackUrl: string) => McpOAuthProvider;
  createConnection?: (
    url: URL,
    info: Implementation,
    options: { transport: McpTransportOptions },
  ) => McpConnection;
};

export class McpClientManager {
  readonly mcpConnections: Record<string, McpConnection> = {};
  private readonly listeners = new Set<() => void>();
  private restored = false;

  constructor(
    private readonly info: Implementation,
    private readonly options: McpClientManagerOptions,
  ) {}

  onServerStateChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listServers(): McpServerRow[] {
    return this.options.rows.list();
  }

  /** Create the in-memory session and persist the server row without connecting. */
  async registerServer(id: string, options: McpRegisterServerOptions): Promise<void> {
    if (isBlockedUrl(options.url)) {
      throw new Error(
        `Blocked URL: ${options.url} — MCP client connections to private/internal addresses are not allowed`,
      );
    }
    this.createConnection(id, options.url, options.transport);
    this.options.rows.save({
      id,
      name: options.name,
      server_url: options.url,
      client_id: null,
      auth_url: null,
      callback_url: options.callbackUrl ?? "",
      server_options: JSON.stringify({ transport: storedTransport(options.transport) }),
    });
    this.fireStateChanged();
  }

  /**
   * Connect a registered server. OAuth servers come back `authenticating`
   * with the URL the person must visit; the callback finishes the flow.
   */
  async connectToServer(id: string): Promise<McpConnectionResult> {
    const connection = this.mcpConnections[id];
    if (!connection) throw new Error(`MCP server ${id} is not registered`);
    const error = await connection.init();
    this.updateStoredSessionId(id, connection.sessionId);
    this.fireStateChanged();
    switch (connection.connectionState) {
      case "failed":
        return { state: "failed", error: error ?? "Unknown connection error" };
      case "authenticating": {
        const provider = connection.options.transport.authProvider;
        const authUrl = provider?.authUrl;
        if (!provider || !authUrl) {
          return { state: "failed", error: "OAuth configuration incomplete: missing authUrl" };
        }
        const clientId = provider.registeredClientId;
        const row = this.options.rows.get(id);
        if (row) {
          this.options.rows.save({ ...row, auth_url: authUrl, client_id: clientId ?? null });
          this.fireStateChanged();
        }
        return clientId === undefined
          ? { state: "authenticating", authUrl }
          : { state: "authenticating", authUrl, clientId };
      }
      case "connected":
        return { state: "connected" };
      default:
        return {
          state: "failed",
          error: `Unexpected connection state after init: ${connection.connectionState}`,
        };
    }
  }

  async discoverIfConnected(
    serverId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<McpDiscoveryResult | undefined> {
    const connection = this.mcpConnections[serverId];
    if (!connection) return undefined;
    const result = await connection.discover(options);
    this.fireStateChanged();
    return result.error === undefined
      ? { success: result.success, state: connection.connectionState }
      : { success: result.success, error: result.error, state: connection.connectionState };
  }

  /** Connect and discover after authorization completed. */
  async establishConnection(serverId: string): Promise<void> {
    const connection = this.mcpConnections[serverId];
    if (!connection) return;
    if (connection.connectionState === "discovering" || connection.connectionState === "ready") {
      return;
    }
    const result = await this.connectToServer(serverId);
    if (result.state === "connected") await this.discoverIfConnected(serverId);
  }

  async restoreConnectionsFromStorage(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    for (const row of this.options.rows.list()) {
      const existing = this.mcpConnections[row.id];
      if (existing) {
        if (existing.connectionState !== "failed") continue;
        await existing.close().catch((error) => {
          console.warn(`[MCP] Error closing failed connection ${row.id}:`, error);
        });
        this.cleanupClosedConnection(row.id);
      }
      const stored = parseStoredTransport(row.server_options);
      const transport: McpTransportOptions = { type: stored.type };
      if (stored.requestInit !== undefined) transport.requestInit = stored.requestInit;
      if (stored.sessionId !== undefined) transport.sessionId = stored.sessionId;
      if (row.callback_url) {
        const provider = this.options.createAuthProvider(row.callback_url);
        provider.serverId = row.id;
        if (row.client_id) provider.clientId = row.client_id;
        transport.authProvider = provider;
      }
      const connection = this.createConnection(row.id, row.server_url, transport);
      if (row.auth_url) {
        connection.connectionState = "authenticating";
        continue;
      }
      await this.restoreServer(row.id);
    }
  }

  isCallbackRequest(request: Request): boolean {
    if (request.method !== "GET") return false;
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const serverId = state ? parseOAuthState(state)?.serverId : undefined;
    if (!serverId) return false;
    const row = this.options.rows.get(serverId);
    if (!row) return false;
    try {
      const stored = new URL(row.callback_url);
      return stored.origin === url.origin && stored.pathname === url.pathname;
    } catch {
      return false;
    }
  }

  async handleCallbackRequest(request: Request): Promise<McpCallbackResult> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (!state) return { authSuccess: false, authError: "Unauthorized: no state provided" };
    const serverId = parseOAuthState(state)?.serverId;
    if (!serverId) {
      return {
        authSuccess: false,
        authError: "No serverId found in state parameter. Expected format: {nonce}.{serverId}",
      };
    }
    if (!this.options.rows.get(serverId)) {
      return { serverId, authSuccess: false, authError: `No server found with id "${serverId}"` };
    }
    const connection = this.mcpConnections[serverId];
    if (!connection) {
      return {
        serverId,
        authSuccess: false,
        authError: `No connection found for serverId "${serverId}"`,
      };
    }
    const provider = connection.options.transport.authProvider;
    if (!provider) {
      return this.failConnection(
        serverId,
        "Trying to finalize authentication for a server connection without an authProvider",
      );
    }
    provider.serverId = serverId;

    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (oauthError || !code) {
      if (isAuthAccepted(connection)) {
        await this.consumeStaleState(serverId, provider, state);
        return this.callbackSuccess(serverId, connection);
      }
      const message = oauthError
        ? url.searchParams.get("error_description") || oauthError
        : "Unauthorized: no code provided";
      return this.failConnection(serverId, message);
    }

    try {
      const check = await provider.checkState(state);
      if (!check.valid) {
        if (isAuthAccepted(connection)) {
          await this.consumeStaleState(serverId, provider, state);
          return this.callbackSuccess(serverId, connection);
        }
        throw new Error(check.error);
      }
      if (isAuthAccepted(connection)) {
        await this.consumeStaleState(serverId, provider, state);
        return this.callbackSuccess(serverId, connection);
      }
      if (connection.connectionState !== "authenticating") {
        throw new Error(
          `Failed to authenticate: the client is in "${connection.connectionState}" state, expected "authenticating"`,
        );
      }
      connection.connectionState = "connecting";
      await provider.consumeState(state);
      await provider.withCallbackState(state, async () => {
        let completeError: unknown;
        try {
          await connection.completeAuthorization(code);
        } catch (error) {
          completeError = error;
        }
        try {
          await provider.deleteCodeVerifier();
        } catch (cleanupError) {
          if (completeError === undefined) throw cleanupError;
          console.warn(`[MCP] Failed to clean up the OAuth code verifier for ${serverId}:`, cleanupError);
        }
        if (completeError !== undefined) throw completeError;
      });
      this.updateStoredSessionId(serverId, connection.sessionId);
      const result = this.callbackSuccess(serverId, connection);
      this.fireStateChanged();
      return result;
    } catch (error) {
      return this.failConnection(serverId, errorMessage(error));
    }
  }

  listTools(filter?: { serverId?: string }): Array<Tool & { serverId: string }> {
    return this.namespaced(filter, (connection) => connection.tools);
  }

  listResources(filter?: { serverId?: string }): Array<Resource & { serverId: string }> {
    return this.namespaced(filter, (connection) => connection.resources);
  }

  listPrompts(filter?: { serverId?: string }): Array<Prompt & { serverId: string }> {
    return this.namespaced(filter, (connection) => connection.prompts);
  }

  async callTool(
    params: { serverId: string } & McpToolCallParams,
    options?: McpToolCallOptions,
  ): Promise<McpToolCallResult> {
    const connection = this.mcpConnections[params.serverId];
    if (!connection) throw new Error(`MCP server ${params.serverId} is not connected`);
    const call: McpToolCallParams = { name: params.name };
    if (params.arguments !== undefined) call.arguments = params.arguments;
    return connection.callTool(call, options);
  }

  /** Close the session if it is open and forget the server. */
  async removeServer(serverId: string): Promise<void> {
    if (this.mcpConnections[serverId]) {
      await this.closeConnection(serverId).catch(() => undefined);
    }
    this.options.rows.remove(serverId);
    this.fireStateChanged();
  }

  private createConnection(
    id: string,
    url: string,
    transport: McpTransportOptions,
  ): McpConnection {
    const existing = this.mcpConnections[id];
    if (existing) return existing;
    const create = this.options.createConnection
      ?? ((target, info, options) => new McpClientConnection(target, info, options));
    const connection = create(new URL(url), this.info, { transport });
    this.mcpConnections[id] = connection;
    return connection;
  }

  private async restoreServer(serverId: string): Promise<void> {
    const result = await this.connectToServer(serverId);
    if (result.state === "failed") {
      console.error(`[MCP] Error connecting to ${serverId}:`, result.error);
      return;
    }
    if (result.state === "connected") {
      const discovery = await this.discoverIfConnected(serverId);
      if (discovery && !discovery.success) {
        console.error(`[MCP] Error discovering ${serverId}:`, discovery.error);
      }
    }
  }

  private async closeConnection(id: string): Promise<void> {
    const connection = this.mcpConnections[id];
    if (!connection) return;
    connection.cancelDiscovery();
    try {
      await connection.close();
    } finally {
      this.cleanupClosedConnection(id);
    }
  }

  private cleanupClosedConnection(id: string): void {
    this.updateStoredSessionId(id, undefined);
    delete this.mcpConnections[id];
  }

  private updateStoredSessionId(id: string, sessionId: string | undefined): void {
    const row = this.options.rows.get(id);
    if (!row) return;
    const stored = parseStoredTransport(row.server_options);
    if (stored.sessionId === sessionId) return;
    const next: StoredTransportOptions = { type: stored.type };
    if (stored.requestInit !== undefined) next.requestInit = stored.requestInit;
    if (sessionId !== undefined) next.sessionId = sessionId;
    this.options.rows.save({ ...row, server_options: JSON.stringify({ transport: next }) });
  }

  private clearAuthUrl(serverId: string): void {
    const row = this.options.rows.get(serverId);
    if (row && row.auth_url !== null) this.options.rows.save({ ...row, auth_url: null });
  }

  private failConnection(serverId: string, error: string): McpCallbackResult {
    this.clearAuthUrl(serverId);
    const connection = this.mcpConnections[serverId];
    if (connection) {
      connection.connectionState = "failed";
      connection.connectionError = error;
    }
    this.fireStateChanged();
    return { serverId, authSuccess: false, authError: error };
  }

  private callbackSuccess(serverId: string, connection: McpConnection): McpCallbackResult {
    this.clearAuthUrl(serverId);
    connection.connectionError = null;
    return { serverId, authSuccess: true };
  }

  private async consumeStaleState(
    serverId: string,
    provider: McpOAuthProvider,
    state: string,
  ): Promise<void> {
    try {
      const check = await provider.checkState(state);
      if (!check.valid) {
        console.warn(`[MCP] Ignoring a stale OAuth callback for ${serverId}: ${check.error}`);
        return;
      }
      await provider.consumeState(state);
    } catch (error) {
      console.warn(`[MCP] Failed to clean up a stale OAuth callback for ${serverId}:`, error);
    }
  }

  private namespaced<T>(
    filter: { serverId?: string } | undefined,
    pick: (connection: McpConnection) => T[],
  ): Array<T & { serverId: string }> {
    const entries = Object.entries(this.mcpConnections).filter(
      ([id]) => filter?.serverId === undefined || filter.serverId === id,
    );
    return entries.flatMap(([serverId, connection]) =>
      pick(connection).map((item) => ({ ...item, serverId })),
    );
  }

  private fireStateChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[MCP] Server state listener failed:", error);
      }
    }
  }
}

function isAuthAccepted(connection: McpConnection): boolean {
  return connection.connectionState === "ready"
    || connection.connectionState === "connected"
    || connection.connectionState === "connecting"
    || connection.connectionState === "discovering";
}

const codedErrorSchema = z.object({ code: z.number() });

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode<T>(error: T): number | undefined {
  const parsed = codedErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
}

function isUnauthorized<T>(error: T): boolean {
  if (error instanceof UnauthorizedError || errorCode(error) === 401) return true;
  const message = errorMessage(error);
  return message.includes("Unauthorized") || message.includes("401");
}

function isTransportNotImplemented<T>(error: T): boolean {
  const code = errorCode(error);
  if (code === 404 || code === 405) return true;
  const message = errorMessage(error);
  return message.includes("404")
    || message.includes("405")
    || message.includes("Not Implemented")
    || message.includes("not implemented");
}

export function isMethodNotFound<T>(error: T): boolean {
  if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return true;
  if (errorCode(error) === ErrorCode.MethodNotFound) return true;
  return /"code"\s*:\s*-32601(?:\s*[,}])/.test(errorMessage(error));
}

const BLOCKED_HOSTNAMES = new Set(["0.0.0.0", "[::]", "metadata.google.internal"]);
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]/;

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return a === 0;
}

function isPrivateIPv6(address: string): boolean {
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (IPV6_LINK_LOCAL.test(address)) return true;
  if (!address.startsWith("::ffff:")) return false;
  const mapped = address.slice(7);
  const dotted = mapped.split(".");
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part))) {
    return isPrivateIPv4(dotted.map(Number));
  }
  const hex = mapped.split(":");
  if (hex.length !== 2) return false;
  const hi = Number.parseInt(hex[0], 16);
  const lo = Number.parseInt(hex[1], 16);
  return isPrivateIPv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);
}

/** Refuse private, link-local, unspecified, and cloud metadata addresses. */
export function isBlockedUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return true;
  }
  const hostname = url.hostname;
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  const dotted = hostname.split(".");
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part))) {
    if (isPrivateIPv4(dotted.map(Number))) return true;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPrivateIPv6(hostname.slice(1, -1).toLowerCase());
  }
  return false;
}
