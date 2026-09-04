import {
  DurableObjectOAuthClientProvider,
  type AgentMcpOAuthProvider,
} from "agents/mcp/do-oauth-client-provider";
import {
  type MCPConnectionResult,
} from "agents/mcp/client";
import type {
  McpAddConnectionInput,
  McpAddConnectionResult,
} from "./sys/mcp";
import type { Kernel } from "./do";


export class McpConnections {
  constructor(readonly host: Kernel) {}

createMcpOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider {
    // SAFETY: the Agents SDK provider implements AgentMcpOAuthProvider; the
    // intersection exposes its supported dynamic client metadata extension.
    const provider = (
      new DurableObjectOAuthClientProvider(this.host.ctx.storage, this.host.installationId, callbackUrl)
    ) as AgentMcpOAuthProvider & { clientMetadataUrl?: string };
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

    const transport = input.transport.headers
      ? {
          authProvider,
          type: input.transport.type,
          requestInit: { headers: input.transport.headers },
        }
      : { authProvider, type: input.transport.type };
    await this.host.mcp.registerServer(serverId, {
      url: input.url,
      name: serverName,
      callbackUrl,
      transport,
    });

    let result: MCPConnectionResult;
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
