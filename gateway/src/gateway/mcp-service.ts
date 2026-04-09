/**
 * MCP tool source. Connects to remote MCP servers over streamable HTTP
 * via @modelcontextprotocol/sdk. Tools are namespaced as {serverId}__{toolName}
 * and cached in memory with configurable TTL.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "../protocol/tools";
import type { McpConfig, McpServerConfig } from "../config";
import { NATIVE_TOOL_PREFIX } from "../agents/tools/constants";

type CachedToolList = {
  tools: ToolDefinition[];
  fetchedAt: number;
};

export type ResolvedMcpTool = {
  serverId: string;
  toolName: string;
  serverConfig: McpServerConfig;
};

/** Race a promise against a timeout, cleaning up the timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const TOOL_SEPARATOR = "__";
const RESERVED_SOURCE_IDS = [NATIVE_TOOL_PREFIX.replace(/__$/, "")];
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (tool list)
const DEFAULT_CLIENT_TTL_MS = 2 * 60 * 1000; // 2 minutes (connection)
const DEFAULT_TIMEOUT_MS = 30_000;

type CachedClient = {
  client: Client;
  connectedAt: number;
};

/** Check if a server ID is valid (not reserved). */
export function isValidMcpServerId(serverId: string): { valid: boolean; reason?: string } {
  if (!serverId) {
    return { valid: false, reason: "server ID cannot be empty" };
  }
  if (RESERVED_SOURCE_IDS.includes(serverId)) {
    return { valid: false, reason: `"${serverId}" is reserved for native tools` };
  }
  if (serverId.includes("__")) {
    return { valid: false, reason: `"${serverId}" contains "__" which breaks tool name routing` };
  }
  return { valid: true };
}

export class McpService {
  private readonly toolCache = new Map<string, CachedToolList>();
  private readonly clientCache = new Map<string, CachedClient>();
  // Stable retry timestamps for servers that failed refresh (prevents alarm sliding)
  private readonly retryAt = new Map<string, number>();

  /**
   * Parse a namespaced tool name and resolve it against MCP config + cache.
   * Returns null if the source isn't an MCP server, the cache is cold/expired,
   * or the tool wasn't discovered. Fail-closed by design.
   */
  resolve(
    namespacedTool: string,
    mcpConfig: McpConfig,
  ): ResolvedMcpTool | null {
    const separatorIdx = namespacedTool.indexOf(TOOL_SEPARATOR);
    if (separatorIdx <= 0 || separatorIdx === namespacedTool.length - TOOL_SEPARATOR.length) {
      return null;
    }

    const sourceId = namespacedTool.slice(0, separatorIdx);
    const toolName = namespacedTool.slice(separatorIdx + TOOL_SEPARATOR.length);

    // Never resolve reserved namespaces as MCP — prevents impersonation
    if (RESERVED_SOURCE_IDS.includes(sourceId)) return null;

    const serverConfig = mcpConfig.servers[sourceId];
    if (!serverConfig) return null;

    // Fail closed: require a warm, non-expired cache before allowing dispatch
    const cached = this.toolCache.get(sourceId);
    if (!cached) return null;

    const ttl = serverConfig.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt > ttl) return null;

    const exists = cached.tools.some((t) => t.name === namespacedTool);
    if (!exists) return null;

    return { serverId: sourceId, toolName, serverConfig };
  }

  /**
   * Return all cached MCP tool definitions (non-expired).
   * These are merged into the unified tool list alongside native and node tools.
   */
  listToolsCached(mcpConfig: McpConfig): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const serverId of Object.keys(mcpConfig.servers)) {
      const cached = this.toolCache.get(serverId);
      if (!cached) continue;

      const ttl = mcpConfig.servers[serverId].cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      if (Date.now() - cached.fetchedAt > ttl) continue;

      tools.push(...cached.tools);
    }
    return tools;
  }

  /** Refresh tool lists from all configured MCP servers in parallel. */
  async refreshCache(mcpConfig: McpConfig): Promise<void> {
    const serverIds = Object.keys(mcpConfig.servers);
    const results = await Promise.allSettled(
      serverIds.map((serverId) =>
        this.fetchToolList(serverId, mcpConfig.servers[serverId]),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        this.toolCache.delete(serverIds[i]);
        const ttl = mcpConfig.servers[serverIds[i]].cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.retryAt.set(serverIds[i], Date.now() + ttl);
        console.error(
          `[McpService] Failed to refresh tool cache for ${serverIds[i]}:`,
          result.reason,
        );
      } else {
        this.retryAt.delete(serverIds[i]);
      }
    }
  }

  /** Earliest cache expiry across all servers, for alarm scheduling. */
  nextCacheExpiryMs(mcpConfig: McpConfig): number | undefined {
    let earliest: number | undefined;
    for (const [serverId, serverConfig] of Object.entries(mcpConfig.servers)) {
      const cached = this.toolCache.get(serverId);
      const ttl = serverConfig.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
      // Use stable retry timestamp for uncached/failed servers (prevents alarm sliding)
      const expiresAt = cached
        ? cached.fetchedAt + ttl
        : this.retryAt.get(serverId) ?? Date.now() + ttl;
      if (earliest === undefined || expiresAt < earliest) {
        earliest = expiresAt;
      }
    }
    return earliest;
  }

  invalidateCache(serverId?: string): void {
    if (serverId) {
      this.toolCache.delete(serverId);
      this.closeClient(serverId);
    } else {
      this.toolCache.clear();
      for (const cached of this.clientCache.values()) {
        cached.client.close().catch(() => {});
      }
      this.clientCache.clear();
    }
  }

  /** Execute a tool call against an MCP server. Reuses cached connections. */
  async callTool(
    serverConfig: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    serverId?: string,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      this.validateServerUrl(serverConfig.url);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const cacheKey = serverId ?? serverConfig.url;

    try {
      const client = await this.getOrCreateClient(cacheKey, serverConfig);

      const response = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: serverConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      );

      // Preserve the full MCP response shape — don't flatten to text-only.
      // Let the caller decide how to present structured/non-text content.
      if (response.isError) {
        const errorText = Array.isArray(response.content)
          ? (response.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text!)
              .join("\n")
          : "MCP tool returned error";
        return { ok: false, error: errorText || "MCP tool returned error" };
      }

      // Return the full response — don't discard structuredContent or metadata
      return { ok: true, result: response };
    } catch (err) {
      // Connection broke — evict so next call gets a fresh client.
      // No automatic retry — side-effecting tools must not be replayed.
      this.closeClient(cacheKey);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get a cached client or create + connect a new one. Keyed by serverId. */
  private async getOrCreateClient(
    cacheKey: string,
    serverConfig: McpServerConfig,
  ): Promise<Client> {
    const cached = this.clientCache.get(cacheKey);

    if (cached && Date.now() - cached.connectedAt < DEFAULT_CLIENT_TTL_MS) {
      return cached.client;
    }

    if (cached) {
      await cached.client.close().catch(() => {});
      this.clientCache.delete(cacheKey);
    }

    const client = this.createClient();
    const transport = this.createTransport(serverConfig);
    const timeoutMs = serverConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    await withTimeout(client.connect(transport), timeoutMs, "MCP connect timeout");

    this.clientCache.set(cacheKey, {
      client,
      connectedAt: Date.now(),
    });

    return client;
  }

  private closeClient(cacheKey: string): void {
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      cached.client.close().catch(() => {});
      this.clientCache.delete(cacheKey);
    }
  }

  private async fetchToolList(
    serverId: string,
    serverConfig: McpServerConfig,
  ): Promise<void> {
    this.validateServerUrl(serverConfig.url);

    const client = this.createClient();
    const transport = this.createTransport(serverConfig);
    const timeoutMs = serverConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      // Bound connect + listTools so a hung server can't stall the alarm cycle
      await withTimeout(client.connect(transport), timeoutMs, `MCP connect timeout for ${serverId}`);
      const response = await withTimeout(client.listTools(), timeoutMs, `MCP listTools timeout for ${serverId}`);
      if (!response.tools || !Array.isArray(response.tools)) {
        throw new Error(
          `MCP tools/list for ${serverId}: invalid response shape`,
        );
      }

      // Namespace tools with {serverId}__ to match the unified tool convention
      const tools: ToolDefinition[] = response.tools.map((tool) => ({
        name: `${serverId}${TOOL_SEPARATOR}${tool.name}`,
        description: tool.description || `Tool from ${serverId}`,
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));

      this.toolCache.set(serverId, {
        tools,
        fetchedAt: Date.now(),
      });

      console.log(
        `[McpService] Refreshed tool cache for ${serverId}: ${tools.length} tools`,
      );
    } finally {
      await client.close().catch(() => {});
    }
  }

  private createClient(): Client {
    return new Client(
      { name: "gsv-gateway", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private createTransport(
    serverConfig: McpServerConfig,
  ): StreamableHTTPClientTransport {
    const headers: Record<string, string> = {};
    if (serverConfig.token) {
      headers["Authorization"] = `Bearer ${serverConfig.token}`;
    }

    // Timeout is handled per-operation by the SDK (callTool, listTools),
    // not at the transport level — a transport-level signal would abort
    // the initialize handshake and conflict with the SDK's own deadline.
    return new StreamableHTTPClientTransport(
      new URL(serverConfig.url),
      { requestInit: { headers } },
    );
  }

  private validateServerUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid MCP server URL: ${url}`);
    }

    if (parsed.protocol === "http:") {
      const hostname = parsed.hostname;
      if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        throw new Error(
          `MCP server URL must use HTTPS (got HTTP for ${hostname}). Use localhost for development.`,
        );
      }
    } else if (parsed.protocol !== "https:") {
      throw new Error(
        `MCP server URL must use HTTPS (got ${parsed.protocol})`,
      );
    }
  }
}
