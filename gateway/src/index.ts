import { WorkerEntrypoint } from "cloudflare:workers";
import { isWebSocketRequest } from "./shared//utils";
import type {
  ChannelInboundMessage,
  ChannelAccountStatus,
  GatewayChannelInterface,
} from "./channel-interface";

export { Gateway } from "./gateway/do";
export { Session } from "./session";

// Re-export channel interface types
export type * from "./channel-interface";

/**
 * Gateway Entrypoint for Service Binding RPC
 *
 * Channel workers call these methods via Service Bindings.
 * This provides a secure, type-safe interface for channels to deliver
 * inbound messages to the Gateway.
 */
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayChannelInterface
{
  /**
   * Receive an inbound message from a channel.
   * Routes to the appropriate session based on peer info.
   */
  async channelInbound(
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ): Promise<{ ok: boolean; sessionKey?: string; error?: string }> {
    try {
      const gateway = this.env.GATEWAY.get(
        this.env.GATEWAY.idFromName("singleton"),
      );

      // Convert to the format Gateway expects
      const result = await gateway.handleChannelInboundRpc({
        channel: channelId,
        accountId,
        peer: message.peer,
        sender: message.sender,
        message: {
          id: message.messageId,
          text: message.text,
          timestamp: message.timestamp,
          replyToId: message.replyToId,
          replyToText: message.replyToText,
          media: message.media,
        },
        wasMentioned: message.wasMentioned,
      });

      return result;
    } catch (e) {
      console.error(`[GatewayEntrypoint] channelInbound failed:`, e);
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Notify Gateway that a channel's status changed.
   * Used for monitoring and health checks.
   */
  async channelStatusChanged(
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ): Promise<void> {
    try {
      const gateway = this.env.GATEWAY.get(
        this.env.GATEWAY.idFromName("singleton"),
      );
      await gateway.handleChannelStatusChanged(channelId, accountId, status);
    } catch (e) {
      console.error(`[GatewayEntrypoint] channelStatusChanged failed:`, e);
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const stub = env.GATEWAY.get(env.GATEWAY.idFromName("singleton"));
      return stub.fetch(request);
    }

    // Serve media files from R2
    // /media/{uuid}.{ext}
    // TODO: either remove or auth this
    const mediaMatch = url.pathname.match(
      /^\/media\/([a-f0-9-]+\.[a-z0-9]+)$/i,
    );
    if (mediaMatch && request.method === "GET") {
      const key = `media/${mediaMatch[1]}`;
      const object = await env.STORAGE.get(key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      // Check if expired
      const expiresAt = object.customMetadata?.expiresAt;
      if (expiresAt && parseInt(expiresAt, 10) < Date.now()) {
        // Clean up expired file
        await env.STORAGE.delete(key);
        return new Response("Expired", { status: 410 });
      }

      const headers = new Headers();
      headers.set(
        "Content-Type",
        object.httpMetadata?.contentType || "application/octet-stream",
      );
      headers.set("Cache-Control", "private, max-age=3600");
      // Allow cross-origin for LLM APIs
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(object.body, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
