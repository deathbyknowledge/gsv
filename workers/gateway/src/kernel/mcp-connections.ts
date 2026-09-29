import type { McpConnectionResult, McpTransportOptions } from "./mcp-client";
import { McpOAuthProvider } from "./mcp-oauth-provider";
import type {
  McpAddConnectionInput,
  McpAddConnectionResult,
} from "./sys/mcp";
import type { Kernel } from "./do";


export class McpConnections {
  constructor(readonly host: Kernel) {}

createMcpOAuthProvider(callbackUrl: string): McpOAuthProvider {
    const provider = new McpOAuthProvider(
      this.host.ctx.storage,
      this.host.installationId,
      callbackUrl,
    );
    const metadataUrl = `${new URL(callbackUrl).origin}/.well-known/oauth-client/gsv.json`;
    if (metadataUrl.startsWith("https://")) {
      provider.clientMetadataUrl = metadataUrl;
    }
    return provider;
  }

async addMcpServerConnection(input: McpAddConnectionInput): Promise<McpAddConnectionResult> {
    const serverName = `u${input.uid}:${input.name}`;
    const serverId = `mcp-${crypto.randomUUID()}`;
    const callbackHost = this.host.installationIdentity?.canonicalOrigin ?? input.callbackHost;
    const callbackUrl = callbackHost
      ? `${callbackHost.replace(/\/$/, "")}/oauth/callback`
      : undefined;
    const authProvider = callbackUrl ? this.createMcpOAuthProvider(callbackUrl) : undefined;
    if (authProvider) {
      authProvider.serverId = serverId;
    }

    const transport: McpTransportOptions = { type: input.transport.type };
    if (authProvider) transport.authProvider = authProvider;
    if (input.transport.headers) transport.requestInit = { headers: input.transport.headers };
    await this.host.mcp.registerServer(serverId, {
      url: input.url,
      name: serverName,
      callbackUrl,
      transport,
    });

    let result: McpConnectionResult;
    try {
      result = await this.host.mcp.connectToServer(serverId);
      if (result.state === "failed") {
        throw new Error(
          `Failed to connect to MCP server at ${input.url}: ${result.error}`,
        );
      }
    } catch (error) {
      try {
        await this.removeMcpServer(serverId);
      } catch (cleanupError) {
        console.warn(
          `[Kernel] Failed to clean up MCP server ${serverId} after add failure:`,
          cleanupError,
        );
      }
      throw error;
    }

    if (result.state === "connected") {
      await this.host.mcp.discoverIfConnected(serverId);
    }
    return { id: serverId };
  }

async refreshMcpServerConnection(serverId: string): Promise<void> {
    const connection = this.host.mcp.mcpConnections[serverId];
    if (connection?.connectionState === "connected" || connection?.connectionState === "ready") {
      await this.host.mcp.discoverIfConnected(serverId);
      return;
    }
    if (
      connection?.connectionState === "authenticating"
      || connection?.connectionState === "connecting"
      || connection?.connectionState === "discovering"
    ) {
      return;
    }

    if (connection) {
      connection.connectionError = null;
    }
    const result = await this.host.mcp.connectToServer(serverId);
    if (result.state === "connected") {
      await this.host.mcp.discoverIfConnected(serverId);
    } else if (result.state === "failed") {
      const failedConnection = this.host.mcp.mcpConnections[serverId];
      if (failedConnection) {
        failedConnection.connectionError = result.error;
      }
      this.broadcastMcpChanged();
    }
  }

async removeMcpServer(serverId: string): Promise<void> {
    await this.host.mcp.removeServer(serverId);
  }

broadcastMcpChanged(): void {
    const uids = new Set(this.host.mcpServers.list().map((record) => record.uid));
    for (const uid of uids) {
      this.host.connectionRuntime.broadcastToUserUid(uid, "mcp.changed");
    }
  }
}
