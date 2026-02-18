/**
 * Discord Gateway Durable Object
 * 
 * Maintains persistent WebSocket connection to Discord's Gateway API.
 * Handles IDENTIFY, HEARTBEAT, RESUME, and dispatches events to GSV Gateway.
 * 
 * Based on: https://discord.com/developers/docs/topics/gateway
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ChannelAccountStatus,
  ChannelInboundMessage,
  ChannelMedia,
} from "./types";

const DISCORD_GATEWAY_URL = "https://discord.com/api/v10/gateway";

// Discord Gateway Opcodes
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Discord Gateway Intents
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024; // 25MB
const BYTE_TO_BASE64_CHUNK_SIZE = 0x1000; // 4KB (avoids argument-list stack overflows)

type GatewayChannelBinding = Fetcher & {
  channelInbound: (
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ) => Promise<{ ok: boolean; sessionKey?: string; status?: string; error?: string }>;
  channelStatusChanged: (
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ) => Promise<void>;
};

type DiscordAttachment = {
  id: string;
  filename: string;
  size?: number;
  url?: string;
  proxyUrl?: string;
  contentType?: string;
  duration?: number;
};

type GatewayState = {
  accountId: string | null;  // The name used to create this DO (e.g., "default")
  botToken: string | null;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  seq: number | null;
  connected: boolean;
  lastHeartbeatAck: number | null;
  lastError: string | null;
};

interface Env {
  GATEWAY: GatewayChannelBinding;
}

export class DiscordGateway extends DurableObject<Env> {
  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000; // 10 seconds
  
  private ws: WebSocket | null = null;
  private heartbeatInterval: number = 0;
  private state: GatewayState = {
    accountId: null,
    botToken: null,
    sessionId: null,
    resumeGatewayUrl: null,
    seq: null,
    connected: false,
    lastHeartbeatAck: null,
    lastError: null,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loadState();
  }

  private async loadState() {
    const stored = await this.ctx.storage.get<GatewayState>("state");
    if (stored) {
      this.state = { ...this.state, ...stored };
    }
  }

  private async saveState() {
    await this.ctx.storage.put("state", this.state);
  }

  // ─────────────────────────────────────────────────────────
  // Public RPC Methods (called by WorkerEntrypoint)
  // ─────────────────────────────────────────────────────────

  async start(botToken: string, accountId?: string): Promise<void> {
    if (this.ws && this.state.connected) {
      console.log("[DiscordGateway] Already connected");
      return;
    }

    // Store the accountId name (not the hex DO id) for consistent inbound routing.
    if (accountId) {
      this.state.accountId = accountId;
    }
    this.state.botToken = botToken;
    await this.saveState();
    await this.connect();
    
    // Schedule keep-alive to prevent DO hibernation
    this.scheduleKeepAlive();
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close(1000, "Stopped by user");
      this.ws = null;
    }
    this.state.connected = false;
    await this.saveState();
    await this.ctx.storage.deleteAlarm();
  }

  async getStatus(): Promise<ChannelAccountStatus> {
    return {
      accountId: this.getAccountId(),
      connected: this.state.connected,
      authenticated: !!this.state.sessionId,
      mode: "gateway",
      lastActivity: this.state.lastHeartbeatAck ?? undefined,
      error: this.state.lastError ?? undefined,
      extra: {
        sessionId: this.state.sessionId,
        seq: this.state.seq,
      },
    };
  }
  
  /** Get the account ID name (e.g., "default"), falling back to hex DO id */
  private getAccountId(): string {
    return this.state.accountId ?? this.ctx.id.toString();
  }

  // ─────────────────────────────────────────────────────────
  // Alarm Handler (keep-alive + heartbeats)
  // ─────────────────────────────────────────────────────────

  async alarm() {
    // Reload state in case we hibernated
    await this.loadState();
    
    // No token = not started, don't reschedule
    if (!this.state.botToken) {
      console.log("[DiscordGateway] No bot token, alarm stopping");
      return;
    }
    
    // Always reschedule to keep DO alive
    this.scheduleKeepAlive();
    
    // Reconnect if WebSocket is gone
    if (!this.ws) {
      console.log("[DiscordGateway] WebSocket lost, reconnecting...");
      try {
        await this.connect();
      } catch (e) {
        console.error("[DiscordGateway] Reconnect failed:", e);
        this.state.lastError = e instanceof Error ? e.message : String(e);
        await this.saveState();
      }
      return;
    }
    
    // Send heartbeat if connected
    if (this.state.connected && this.heartbeatInterval > 0) {
      await this.sendHeartbeat();
    }
  }
  
  private scheduleKeepAlive(): void {
    this.ctx.storage.setAlarm(Date.now() + DiscordGateway.KEEP_ALIVE_INTERVAL_MS);
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket Connection
  // ─────────────────────────────────────────────────────────

  private async connect() {
    console.log("[DiscordGateway] Connecting...");

    // Get gateway URL
    let gatewayUrl = this.state.resumeGatewayUrl;
    if (!gatewayUrl) {
      const response = await fetch(DISCORD_GATEWAY_URL);
      const data = await response.json<{ url: string }>();
      gatewayUrl = data.url;
    }

    // Parse and modify URL for WebSocket
    const url = new URL(gatewayUrl);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");

    // Open WebSocket connection
    const response = await fetch(url.toString().replace("wss://", "https://"), {
      headers: {
        Upgrade: "websocket",
      },
    });

    const ws = response.webSocket;
    if (!ws) {
      this.state.lastError = "Failed to establish WebSocket connection";
      await this.saveState();
      throw new Error(this.state.lastError);
    }

    ws.accept();
    this.ws = ws;

    // Set up event handlers
    ws.addEventListener("message", (event) => this.handleMessage(event.data as string));
    ws.addEventListener("close", (event) => this.handleClose(event));
    ws.addEventListener("error", (event) => this.handleError(event));
  }

  private async handleMessage(rawData: string) {
    const payload = JSON.parse(rawData);
    const { op, t, d, s } = payload;

    // Track sequence number
    if (s !== null) {
      this.state.seq = s;
    }

    switch (op) {
      case OP.HELLO:
        this.heartbeatInterval = d.heartbeat_interval;
        await this.scheduleHeartbeat();
        
        // IDENTIFY or RESUME
        if (this.state.sessionId && this.state.seq !== null) {
          await this.resume();
        } else {
          await this.identify();
        }
        break;

      case OP.HEARTBEAT_ACK:
        this.state.lastHeartbeatAck = Date.now();
        break;

      case OP.DISPATCH:
        await this.handleDispatch(t, d);
        break;

      case OP.RECONNECT:
        console.log("[DiscordGateway] Received RECONNECT, reconnecting...");
        this.ws?.close(4000, "Reconnect requested");
        break;

      case OP.INVALID_SESSION:
        console.log("[DiscordGateway] Invalid session, re-identifying...");
        this.state.sessionId = null;
        this.state.seq = null;
        await this.saveState();
        
        // Wait a bit before re-identifying (Discord docs recommend 1-5 seconds)
        await new Promise((r) => setTimeout(r, 2000));
        await this.identify();
        break;
    }

    await this.saveState();
  }

  private async handleDispatch(eventType: string, data: unknown) {
    const d = data as Record<string, unknown>;

    switch (eventType) {
      case "READY":
        this.state.sessionId = d.session_id as string;
        this.state.resumeGatewayUrl = d.resume_gateway_url as string;
        this.state.connected = true;
        this.state.lastError = null;
        
        // Store bot user info for mention detection
        const botUser = d.user as { id: string; username: string } | undefined;
        if (botUser) {
          await this.ctx.storage.put("botUser", { id: botUser.id, username: botUser.username });
        }
        
        console.log(`[DiscordGateway] Connected as ${botUser?.username} (${botUser?.id})`);
        
        // Notify Gateway of status change via Service Binding RPC.
        const accountId = this.getAccountId();
        await this.notifyGatewayStatus({
          accountId,
          connected: true,
          authenticated: true,
          mode: "gateway",
          extra: { botUserId: botUser?.id, botUsername: botUser?.username },
        });
        
        await this.saveState();
        break;

      case "RESUMED":
        this.state.connected = true;
        this.state.lastError = null;
        console.log("[DiscordGateway] Session resumed");
        await this.saveState();
        break;

      case "MESSAGE_CREATE":
        await this.handleMessageCreate(d);
        break;

      // Add more event handlers as needed
    }
  }

  private async handleMessageCreate(data: Record<string, unknown>) {
    const author = data.author as { id: string; username: string; bot?: boolean; discriminator?: string } | undefined;
    
    // Ignore bot messages
    if (author?.bot) return;

    const content = typeof data.content === "string" ? data.content : "";
    const media = await this.extractMediaAttachments(data);
    if (!content && media.length === 0) return;

    const guildId = data.guild_id as string | undefined;
    const channelId = data.channel_id as string;
    const messageId = data.id as string;
    const messageReference = data.message_reference as
      | { message_id?: string }
      | undefined;

    // Check if bot was mentioned
    const mentions = Array.isArray(data.mentions)
      ? (data.mentions as Array<{ id?: string }>)
      : [];
    const botUser = await this.ctx.storage.get<{ id: string }>("botUser");
    const wasMentioned = mentions?.some(m => m.id === botUser?.id) ?? false;

    // Build inbound message
    const message: ChannelInboundMessage = {
      messageId,
      peer: {
        kind: guildId ? "group" : "dm",
        id: channelId,
        name: undefined, // Could fetch channel name
      },
      sender: author ? {
        id: author.id,
        name: author.username,
        handle: author.discriminator ? `${author.username}#${author.discriminator}` : author.username,
      } : undefined,
      text: content || "[Media]",
      media: media.length > 0 ? media : undefined,
      replyToId:
        messageReference && typeof messageReference.message_id === "string"
          ? messageReference.message_id
          : undefined,
      timestamp: data.timestamp ? new Date(data.timestamp as string).getTime() : Date.now(),
      wasMentioned,
    };

    // Forward to GSV Gateway via Service Binding RPC.
    try {
      const result = await this.env.GATEWAY.channelInbound(
        "discord",
        this.getAccountId(),
        message,
      );
      if (!result.ok) {
        console.error(
          `[DiscordGateway] Inbound rejected by gateway: ${result.error ?? "unknown error"}`,
        );
        return;
      }
      console.log(
        `[DiscordGateway] Delivered message ${messageId} from ${author?.username}`,
      );
    } catch (e) {
      console.error("[DiscordGateway] Failed to deliver inbound via RPC:", e);
    }
  }

  private async notifyGatewayStatus(status: ChannelAccountStatus): Promise<void> {
    const accountId = this.getAccountId();
    try {
      await this.env.GATEWAY.channelStatusChanged("discord", accountId, status);
    } catch (e) {
      console.error("[DiscordGateway] Failed to deliver status via RPC:", e);
    }
  }

  private async extractMediaAttachments(
    data: Record<string, unknown>,
  ): Promise<ChannelMedia[]> {
    if (!Array.isArray(data.attachments)) {
      return [];
    }

    const media: ChannelMedia[] = [];
    for (const rawAttachment of data.attachments) {
      const attachment = this.parseAttachment(rawAttachment);
      if (!attachment) continue;

      const converted = await this.attachmentToMedia(attachment);
      if (converted) {
        media.push(converted);
      }
    }

    return media;
  }

  private parseAttachment(raw: unknown): DiscordAttachment | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const value = raw as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id : null;
    const filename = typeof value.filename === "string" ? value.filename : null;
    const url = typeof value.url === "string" ? value.url : undefined;
    const proxyUrl =
      typeof value.proxy_url === "string" ? value.proxy_url : undefined;

    if (!id || !filename) {
      return null;
    }

    return {
      id,
      filename,
      size: typeof value.size === "number" ? value.size : undefined,
      url,
      proxyUrl,
      contentType:
        typeof value.content_type === "string"
          ? value.content_type
          : undefined,
      duration:
        typeof value.duration_secs === "number"
          ? value.duration_secs
          : undefined,
    };
  }

  private async attachmentToMedia(
    attachment: DiscordAttachment,
  ): Promise<ChannelMedia | null> {
    const mimeType =
      attachment.contentType || this.inferMimeTypeFromFilename(attachment.filename);
    const type = this.inferMediaTypeFromMime(mimeType);
    const url = attachment.url || attachment.proxyUrl;

    const base: ChannelMedia = {
      type,
      mimeType,
      url,
      filename: attachment.filename,
      size: attachment.size,
      duration: attachment.duration,
    };

    if (!url) {
      return base;
    }

    if (attachment.size && attachment.size > MAX_INLINE_MEDIA_BYTES) {
      console.log(
        `[DiscordGateway] Attachment ${attachment.id} too large for inline data (${attachment.size} bytes)`,
      );
      return base;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[DiscordGateway] Failed to download attachment ${attachment.id}: HTTP ${response.status}`,
        );
        return base;
      }

      const contentLength = parseInt(
        response.headers.get("content-length") || "0",
        10,
      );
      if (contentLength > MAX_INLINE_MEDIA_BYTES) {
        console.log(
          `[DiscordGateway] Attachment ${attachment.id} content-length exceeds inline limit (${contentLength} bytes)`,
        );
        return base;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_INLINE_MEDIA_BYTES) {
        console.log(
          `[DiscordGateway] Attachment ${attachment.id} body exceeds inline limit (${bytes.byteLength} bytes)`,
        );
        return base;
      }

      return {
        ...base,
        data: this.bytesToBase64(bytes),
        size: attachment.size ?? bytes.byteLength,
      };
    } catch (e) {
      console.warn(
        `[DiscordGateway] Error downloading attachment ${attachment.id}: ${e}`,
      );
      return base;
    }
  }

  private inferMediaTypeFromMime(mimeType: string): ChannelMedia["type"] {
    const normalized = mimeType.split(";")[0].trim().toLowerCase();
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("audio/")) return "audio";
    if (normalized.startsWith("video/")) return "video";
    return "document";
  }

  private inferMimeTypeFromFilename(filename: string): string {
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      opus: "audio/opus",
      wav: "audio/wav",
      m4a: "audio/mp4",
      webm: "audio/webm",
      mp4: "video/mp4",
      mov: "video/quicktime",
      pdf: "application/pdf",
    };
    return map[extension] || "application/octet-stream";
  }

  private bytesToBase64(bytes: Uint8Array): string {
    if (bytes.length === 0) return "";

    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += BYTE_TO_BASE64_CHUNK_SIZE) {
      chunks.push(
        String.fromCharCode(...bytes.subarray(i, i + BYTE_TO_BASE64_CHUNK_SIZE)),
      );
    }
    return btoa(chunks.join(""));
  }

  private async identify() {
    if (!this.state.botToken) {
      throw new Error("No bot token set");
    }

    const intents = 
      INTENTS.GUILDS |
      INTENTS.GUILD_MESSAGES |
      INTENTS.DIRECT_MESSAGES |
      INTENTS.MESSAGE_CONTENT;

    this.ws?.send(JSON.stringify({
      op: OP.IDENTIFY,
      d: {
        token: this.state.botToken,
        intents,
        properties: {
          os: "cloudflare",
          browser: "gsv",
          device: "gsv",
        },
      },
    }));
  }

  private async resume() {
    if (!this.state.botToken || !this.state.sessionId) {
      return this.identify();
    }

    this.ws?.send(JSON.stringify({
      op: OP.RESUME,
      d: {
        token: this.state.botToken,
        session_id: this.state.sessionId,
        seq: this.state.seq,
      },
    }));
  }

  private async sendHeartbeat() {
    if (!this.ws) return;

    this.ws.send(JSON.stringify({
      op: OP.HEARTBEAT,
      d: this.state.seq,
    }));

    await this.scheduleHeartbeat();
  }

  private async scheduleHeartbeat() {
    // Heartbeats are now sent via the keep-alive alarm
    // This method is kept for the initial heartbeat after HELLO
    // No need to schedule separate alarms - keep-alive handles it
  }

  private handleClose(event: CloseEvent) {
    console.log(`[DiscordGateway] WebSocket closed: ${event.code} ${event.reason}`);
    this.ws = null;
    this.state.connected = false;

    // Attempt to reconnect for recoverable close codes
    const recoverableCodes = [4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009];
    if (recoverableCodes.includes(event.code) && this.state.botToken) {
      console.log("[DiscordGateway] Attempting to reconnect...");
      this.ctx.waitUntil(this.connect());
    }
  }

  private handleError(event: Event) {
    console.error("[DiscordGateway] WebSocket error:", event);
    this.state.lastError = "WebSocket error";
  }
}
