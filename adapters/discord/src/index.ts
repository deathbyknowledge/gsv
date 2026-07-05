/**
 * GSV Discord Channel Worker
 * 
 * Implements ChannelWorkerInterface for Discord integration.
 * Uses a Durable Object (DiscordGateway) to maintain persistent WebSocket
 * connection to Discord's Gateway API.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  isHelpCommand,
  parseAttachArgs,
  parseShellWords,
} from "../../shared/src/command";
import type {
  ShellExecArgs,
  ShellExecResult,
} from "../../shared/src/types";
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

/**
 * Discord Channel Entrypoint
 * 
 * Gateway calls these methods via Service Binding.
 */
// Named export for service binding entrypoint
export class DiscordChannel extends WorkerEntrypoint<Env> implements ChannelWorkerInterface {
  readonly channelId = "discord";
  readonly adapterId = "discord";
  
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
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks adapter RPC calls.
  async adapterConnect(accountId: string, config: Record<string, unknown> = {}): Promise<
    | { ok: true; connected: boolean; authenticated: boolean; message?: string }
    | { ok: false; error: string }
  > {
    const started = await this.start(accountId, config);
    if (!started.ok) {
      return { ok: false, error: started.error };
    }
    return {
      ok: true,
      connected: true,
      authenticated: true,
      message: "Connected",
    };
  }

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  async adapterDisconnect(accountId: string): Promise<
    | { ok: true; message?: string }
    | { ok: false; error: string }
  > {
    const stopped = await this.stop(accountId);
    if (!stopped.ok) {
      return { ok: false, error: stopped.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async disconnect(accountId: string) {
    return this.adapterDisconnect(accountId);
  }

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
  async adapterStatus(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (accountId) {
      const gateway = this.getGatewayDO(accountId);
      const state = await gateway.getStatus();
      return [state];
    }
    // TODO: Track all active accounts and return their statuses
    return [];
  }

  async status(accountId?: string) {
    return this.adapterStatus(accountId);
  }

  /**
   * Send a message to a Discord channel.
   */
  async adapterSend(
    accountId: string,
    message: {
      surface: ChannelPeer;
      text: string;
      media?: ChannelMedia[];
      replyToId?: string;
    },
  ): Promise<SendResult> {
    const botToken = await this.resolveBotToken(accountId);
    if (!botToken) {
      return { ok: false, error: "No bot token configured" };
    }

    try {
      const channelId = message.surface.id;
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

  async send(accountId: string, message: ChannelOutboundMessage) {
    return this.adapterSend(accountId, {
      surface: message.peer,
      text: message.text,
      media: message.media,
      replyToId: message.replyToId,
    });
  }

  async adapterSetActivity(
    accountId: string,
    surface: ChannelPeer,
    activity: { kind: "typing" | "recording" | "uploading"; active: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      await this.setTyping(accountId, surface, activity.active);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Send typing indicator.
   */
  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    if (!typing) return; // Discord doesn't have "stop typing"

    const botToken = await this.resolveBotToken(accountId);
    if (!botToken) return;

    await this.discordFetch(`/channels/${peer.id}/typing`, {
      method: "POST",
      botToken,
    });
  }

  async adapterShellExec(accountId: string, args: ShellExecArgs): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";

    if (isHelpCommand(command)) {
      return shellOk([
        "discord adapter commands:",
        "  help | -h | --help",
        "  send <channel-id> <text>",
        "  reply <channel-id> <message-id> <text>",
        "  react <channel-id> <message-id> <emoji>",
        "  attach <channel-id> <url> [--filename <name>] [caption]",
      ].join("\n"));
    }

    if (command === "send") {
      const [channelId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!channelId || !text) {
        return shellFail("usage: send <channel-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      const [channelId, messageId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!channelId || !messageId || !text) {
        return shellFail("usage: reply <channel-id> <message-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text,
        replyToId: messageId,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "react") {
      const [channelId, messageId, emoji] = tokens.slice(1);
      if (!channelId || !messageId || !emoji) {
        return shellFail("usage: react <channel-id> <message-id> <emoji>");
      }
      const botToken = await this.resolveBotToken(accountId);
      if (!botToken) {
        return shellFail("No bot token configured");
      }
      const response = await this.discordFetch(
        `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: "PUT", botToken },
      );
      return response.ok
        ? shellOk("reacted")
        : shellFail(`Discord API error: ${response.status} ${await response.text()}`);
    }

    if (command === "attach") {
      const { targetId: channelId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!channelId || !url) {
        return shellFail("usage: attach <channel-id> <url> [--filename <name>] [caption]");
      }
      const media = await mediaFromUrl(url, filename);
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text: caption,
        media: [media],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    return shellFail(`unknown command: ${command}`);
  }

  // ─────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────

  private getGatewayDO(accountId: string) {
    const id = this.env.DISCORD_GATEWAY.idFromName(accountId);
    return this.env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
  }

  private async resolveBotToken(accountId: string): Promise<string | null> {
    const gateway = this.getGatewayDO(accountId);
    const persistedToken = await gateway.getBotToken();
    return persistedToken || this.env.DISCORD_BOT_TOKEN || null;
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

function discordSurface(id: string): ChannelPeer {
  return { kind: "channel", id: id.trim() };
}

async function mediaFromUrl(url: string, filename?: string): Promise<ChannelMedia> {
  let mimeType = "application/octet-stream";
  try {
    const response = await fetch(url, { method: "HEAD" });
    mimeType = response.headers.get("Content-Type")?.split(";")[0].trim() || mimeType;
  } catch {
    // The upload path can still fetch the URL later; content type falls back.
  }

  return {
    type: mediaTypeFromMime(mimeType),
    mimeType,
    url,
    ...(filename ? { filename } : {}),
  };
}

function mediaTypeFromMime(mimeType: string): ChannelMedia["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function shellOk(output: string): ShellExecResult {
  return {
    status: "completed",
    output,
    exitCode: 0,
    ok: true,
    pid: 0,
    stdout: output,
    stderr: "",
  };
}

function shellFail(error: string): ShellExecResult {
  return {
    status: "failed",
    output: error,
    error,
    exitCode: 1,
    ok: false,
    pid: 0,
    stdout: "",
    stderr: error,
  };
}

// Type for DO stub methods
interface DiscordGatewayStub {
  start(botToken: string, accountId?: string): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ChannelAccountStatus>;
  getBotToken(): Promise<string | null>;
}

// Default export: HTTP handler for direct requests
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-discord",
        status: "ok",
      });
    }

    // Adapter setup, lifecycle, and account status are service-binding only.
    if (url.pathname === "/setup" || url.pathname === "/start" || url.pathname === "/stop" || url.pathname === "/status") {
      return new Response("Not Found", { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
