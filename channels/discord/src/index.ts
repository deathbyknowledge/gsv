/**
 * GSV Discord Channel Worker
 * 
 * Implements ChannelWorkerInterface for Discord integration.
 * Uses a Durable Object (DiscordGateway) to maintain persistent WebSocket
 * connection to Discord's Gateway API.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ChannelWorkerInterface,
  ChannelCapabilities,
  ChannelMedia,
  ChannelAccountStatus,
  ChannelOutboundMessage,
  ChannelPeer,
  StartResult,
  StopResult,
  SendResult,
} from "./types";

export { DiscordGateway } from "./discord-gateway";

// Re-export interface types for consumers
export type * from "./types";

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace;
  // Secrets
  DISCORD_BOT_TOKEN?: string;
}

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_INVITE_PERMISSIONS = 101376; // View Channels + Send Messages + Attach Files + Read Message History

/**
 * Discord Channel Entrypoint
 * 
 * Gateway calls these methods via Service Binding.
 */
// Named export for service binding entrypoint
export class DiscordChannel extends WorkerEntrypoint<Env> implements ChannelWorkerInterface {
  readonly channelId = "discord";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group", "channel", "thread"],
    media: true,
    reactions: true,
    threads: true,
    typing: true,
    editing: true,
    deletion: true,
  };

  /**
   * Start Discord Gateway connection for an account.
   */
  async start(accountId: string, config: Record<string, unknown>): Promise<StartResult> {
    const botToken = (config.botToken as string) || this.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { ok: false, error: "No bot token provided" };
    }

    try {
      const gateway = this.getGatewayDO(accountId);
      await gateway.start(botToken, accountId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Stop Discord Gateway connection.
   */
  async stop(accountId: string): Promise<StopResult> {
    try {
      const gateway = this.getGatewayDO(accountId);
      await gateway.stop();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Get status of Discord connection(s).
   */
  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (accountId) {
      const gateway = this.getGatewayDO(accountId);
      const state = await gateway.getStatus();
      return [state];
    }
    // TODO: Track all active accounts and return their statuses
    return [];
  }

  /**
   * Send a message to a Discord channel.
   */
  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
    const botToken = this.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { ok: false, error: "No bot token configured" };
    }

    try {
      const channelId = message.peer.id;
      const body: Record<string, unknown> = {};
      const hasText = message.text.trim().length > 0;
      const media = message.media ?? [];

      if (!hasText && media.length === 0) {
        return { ok: false, error: "Discord messages require text or media" };
      }

      if (hasText) {
        body.content = message.text;
      }

      if (message.replyToId) {
        body.message_reference = {
          message_id: message.replyToId,
        };
      }

      let requestBody: BodyInit;
      if (media.length > 0) {
        const form = new FormData();
        const attachments: Array<{ id: number; filename: string }> = [];

        for (const [index, attachment] of media.entries()) {
          const file = await this.prepareUploadFile(attachment, index);
          form.append(`files[${index}]`, file.blob, file.filename);
          attachments.push({ id: index, filename: file.filename });
        }

        body.attachments = attachments;
        form.append("payload_json", JSON.stringify(body));
        requestBody = form;
      } else {
        requestBody = JSON.stringify(body);
      }

      const response = await this.discordFetch(`/channels/${channelId}/messages`, {
        method: "POST",
        botToken,
        body: requestBody,
      });

      if (!response.ok) {
        const error = await response.text();
        return { ok: false, error: `Discord API error: ${response.status} ${error}` };
      }

      const data = await response.json<{ id: string }>();
      return { ok: true, messageId: data.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Send typing indicator.
   */
  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    if (!typing) return; // Discord doesn't have "stop typing"

    const botToken = this.env.DISCORD_BOT_TOKEN;
    if (!botToken) return;

    await this.discordFetch(`/channels/${peer.id}/typing`, {
      method: "POST",
      botToken,
    });
  }

  // ─────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────

  private getGatewayDO(accountId: string) {
    const id = this.env.DISCORD_GATEWAY.idFromName(accountId);
    return this.env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
  }

  private async discordFetch(
    path: string,
    init: RequestInit & { botToken: string }
  ): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bot ${init.botToken}`);
    const isFormDataBody = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (!headers.has("Content-Type") && init.body && !isFormDataBody) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    const response = await fetch(`${DISCORD_API}${path}`, { ...init, headers });

    // Handle rate limiting
    if (response.status === 429) {
      const data = await response.json<{ retry_after?: number }>();
      const retryAfterMs = Math.ceil((data.retry_after ?? 1) * 1000);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      return fetch(`${DISCORD_API}${path}`, { ...init, headers });
    }

    return response;
  }

  private async prepareUploadFile(
    media: ChannelMedia,
    index: number,
  ): Promise<{ blob: Blob; filename: string }> {
    const filename =
      media.filename ||
      `attachment-${index + 1}.${this.getExtensionFromMime(media.mimeType, media.type)}`;

    if (media.data) {
      const bytes = this.decodeBase64(media.data);
      return {
        blob: new Blob([bytes], { type: media.mimeType }),
        filename,
      };
    }

    if (media.url) {
      const response = await fetch(media.url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch media from url (${response.status} ${response.statusText})`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      return {
        blob: new Blob([arrayBuffer], { type: media.mimeType }),
        filename,
      };
    }

    throw new Error("Media attachment must include base64 data or url");
  }

  private decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private getExtensionFromMime(
    mimeType: string,
    mediaType: ChannelMedia["type"],
  ): string {
    const normalized = mimeType.split(";")[0].trim().toLowerCase();
    const mapping: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "audio/ogg": "ogg",
      "audio/opus": "opus",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "m4a",
      "audio/wav": "wav",
      "audio/webm": "webm",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "application/pdf": "pdf",
    };

    const fromMime = mapping[normalized];
    if (fromMime) return fromMime;
    return mediaType === "document" ? "bin" : mediaType;
  }
}

// Type for DO stub methods
interface DiscordGatewayStub {
  start(botToken: string, accountId?: string): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ChannelAccountStatus>;
}

// Default export: HTTP handler for direct requests
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-discord",
        status: "ok",
        hasToken: !!env.DISCORD_BOT_TOKEN,
      });
    }

    // GET /setup - Verify bot configuration and show setup info
    if (url.pathname === "/setup" && request.method === "GET") {
      const botToken = env.DISCORD_BOT_TOKEN;
      if (!botToken) {
        return Response.json({
          ok: false,
          error: "DISCORD_BOT_TOKEN not configured",
          help: "Set via: wrangler secret put DISCORD_BOT_TOKEN",
        }, { status: 400 });
      }

      // Fetch bot info from Discord API
      try {
        const response = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${botToken}` },
        });

        if (!response.ok) {
          const error = await response.text();
          return Response.json({
            ok: false,
            error: `Discord API error: ${response.status}`,
            details: error,
            help: "Check that your bot token is valid",
          }, { status: 400 });
        }

        const bot = await response.json<{ id: string; username: string; discriminator: string }>();
        
        // Fetch application info for invite URL
        const appResponse = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
          headers: { Authorization: `Bot ${botToken}` },
        });
        
        let appId = "UNKNOWN";
        if (appResponse.ok) {
          const app = await appResponse.json<{ id: string }>();
          appId = app.id;
        }

        const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot`;

        return Response.json({
          ok: true,
          bot: {
            id: bot.id,
            username: bot.username,
            tag: `${bot.username}#${bot.discriminator}`,
          },
          applicationId: appId,
          inviteUrl,
          setup: {
            step1: "Ensure MESSAGE_CONTENT intent is enabled in Discord Developer Portal",
            step2: `Invite bot to server (with Attach Files permission): ${inviteUrl}`,
            step3: "Start the bot: POST /start",
          },
        });
      } catch (e) {
        return Response.json({
          ok: false,
          error: `Failed to verify bot: ${e}`,
        }, { status: 500 });
      }
    }

    // POST /start?accountId=xxx
    if (url.pathname === "/start" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId") || "default";
      const botToken = env.DISCORD_BOT_TOKEN;
      if (!botToken) {
        return Response.json({ ok: false, error: "No bot token configured" }, { status: 400 });
      }
      
      const id = env.DISCORD_GATEWAY.idFromName(accountId);
      const gateway = env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
      
      try {
        await gateway.start(botToken, accountId);
        return Response.json({ ok: true, accountId });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    // POST /stop?accountId=xxx
    if (url.pathname === "/stop" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId") || "default";
      const id = env.DISCORD_GATEWAY.idFromName(accountId);
      const gateway = env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
      
      try {
        await gateway.stop();
        return Response.json({ ok: true, accountId });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    // GET /status?accountId=xxx
    if (url.pathname === "/status" && request.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "default";
      const id = env.DISCORD_GATEWAY.idFromName(accountId);
      const gateway = env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
      
      try {
        const status = await gateway.getStatus();
        return Response.json(status);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
