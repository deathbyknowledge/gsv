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
  ChannelMedia,
  ChannelPeer,
} from "./types";
import type {
  AdapterInboundMessage,
  AdapterInboundResult,
  GatewayFrame,
  GatewayRequestFrame,
} from "../../shared/src/types";
import {
  ManagedLifecycleFence,
  type ManagedLifecycleInventory,
} from "../../shared/src/managed-lifecycle";
import {
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  type ManagedObjectDescriptor,
} from "@humansandmachines/gsv/protocol/managed-objects";
import {
  validateManagedRestoreControl,
  validateManagedSnapshotRequest,
  type ManagedObjectRestoreControl,
  type ManagedObjectSnapshotRequest,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import {
  prepareManagedAdapterRestoreTarget,
  readAdapterRestoreTarget,
  restoreManagedAdapterStorage,
  snapshotManagedAdapterStorage,
} from "../../shared/src/managed-portability";

const DISCORD_GATEWAY_URL = "https://discord.com/api/v10/gateway";
const DISCORD_API = "https://discord.com/api/v10";

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
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
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
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
}

export class DiscordGateway extends DurableObject<Env> {
  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000; // 10 seconds
  
  private readonly lifecycle: ManagedLifecycleFence;
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
    this.lifecycle = new ManagedLifecycleFence(this.ctx.storage);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.lifecycle.load();
      await this.loadState();
      // This implementation does not use WebSocket hibernation, so an isolate
      // restart never retains the in-memory socket even if the prior snapshot
      // said it was connected.
      this.state.connected = false;
    });
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
    const epoch = this.lifecycle.activeEpoch();
    if (this.ws && this.state.connected) {
      console.log("[DiscordGateway] Already connected");
      return;
    }

    // Store the accountId name (not the hex DO id) for consistent inbound routing.
    if (accountId) await this.bindAccountId(accountId, epoch);
    this.state.botToken = botToken;
    await this.saveState();
    this.lifecycle.assertActive(epoch);
    await this.openGatewayConnection(epoch);
    
    // Schedule keep-alive to prevent DO hibernation
    await this.scheduleKeepAlive(epoch);
  }

  async stop(): Promise<void> {
    const epoch = this.lifecycle.activeEpoch();
    this.closeSocket(1000, "Stopped by user");
    this.state.connected = false;
    await this.saveState();
    this.lifecycle.assertActive(epoch);
    await this.ctx.storage.deleteAlarm();
  }

  async managedPause(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.pause();
      this.closeSocket(1001, "Managed account paused");
      this.state.connected = false;
      await Promise.all([this.saveState(), this.ctx.storage.deleteAlarm()]);
      return this.lifecycle.snapshot(this.getAccountId());
    });
  }

  async managedResume(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.resume();
      const epoch = this.lifecycle.activeEpoch();
      if (this.state.botToken) {
        if (!this.ws) {
          await this.openGatewayConnection(epoch);
        }
        if (this.lifecycle.isActive(epoch)) {
          await this.scheduleKeepAlive(epoch);
        }
      }
      return this.lifecycle.snapshot(this.getAccountId());
    });
  }

  async managedErase(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.erase();
      this.closeSocket(1001, "Managed account erased");
      await this.ctx.storage.deleteAlarm();
      const erasedState: GatewayState = {
        accountId: this.getAccountId(),
        botToken: null,
        sessionId: null,
        resumeGatewayUrl: null,
        seq: null,
        connected: false,
        lastHeartbeatAck: null,
        lastError: null,
      };
      await this.lifecycle.eraseStorage({ state: erasedState });
      this.state = erasedState;
      this.heartbeatInterval = 0;
      return this.lifecycle.snapshot(this.getAccountId());
    });
  }

  async managedDescriptor(): Promise<ManagedObjectDescriptor> {
    const lifecycle = this.lifecycle.snapshot(this.getAccountId());
    if (!this.state.accountId) {
      return {
        schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
        kind: "adapter_account",
        providerId: this.ctx.id.toString(),
        logicalName: null,
        classification: "uninitialized",
        lifecycle: { status: "uninitialized", epoch: lifecycle.epoch },
      };
    }
    return {
      schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
      kind: "adapter_account",
      providerId: this.ctx.id.toString(),
      logicalName: this.state.accountId,
      classification: lifecycle.status === "erased" ? "erased" : "initialized",
      lifecycle: { status: lifecycle.status, epoch: lifecycle.epoch },
    };
  }

  async managedSnapshot(input: ManagedObjectSnapshotRequest): Promise<ReadableStream<Uint8Array>> {
    const request = validateManagedSnapshotRequest(input);
    this.assertManagedPortableIdentity(
      request.component,
      request.kind,
      request.logicalName,
      request.providerId,
      request.fenceEpoch,
    );
    const descriptor = await this.managedDescriptor();
    if (
      descriptor.classification !== "initialized"
      || descriptor.logicalName !== request.logicalName
      || descriptor.lifecycle.status !== "paused"
    ) {
      throw new Error("Discord account is not a paused initialized snapshot source");
    }
    return snapshotManagedAdapterStorage(
      this.ctx.storage,
      request.objectId,
      () => this.lifecycle.assertPaused(request.fenceEpoch),
    );
  }

  async managedRestore(
    input: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ) {
    return this.lifecycle.runExclusive(async () => {
      try {
        const control = validateManagedRestoreControl(input);
        this.assertManagedTargetIdentity(control);
        if (!readAdapterRestoreTarget(this.ctx.storage)) {
          if (this.state.accountId !== null) {
            throw new Error("Discord restore target is not fresh");
          }
          await this.lifecycle.prepareRestore(control.fenceEpoch);
          this.closeSocket(1001, "Managed account is being restored");
          await this.ctx.storage.deleteAlarm();
        }
        this.lifecycle.assertPaused(control.fenceEpoch);
        await prepareManagedAdapterRestoreTarget(this.ctx.storage, control);
        const result = await restoreManagedAdapterStorage(
          this.ctx.storage,
          stream,
          control,
          () => this.lifecycle.assertPaused(control.fenceEpoch),
        );
        this.state = {
          accountId: null,
          botToken: null,
          sessionId: null,
          resumeGatewayUrl: null,
          seq: null,
          connected: false,
          lastHeartbeatAck: null,
          lastError: null,
        };
        await this.loadState();
        this.state.connected = false;
        this.heartbeatInterval = 0;
        const descriptor = await this.managedDescriptor();
        if (
          descriptor.classification !== "initialized"
          || descriptor.logicalName !== control.logicalName
          || descriptor.providerId !== this.ctx.id.toString()
        ) {
          throw new Error("Restored Discord identity does not match its target");
        }
        return { ...result, providerId: descriptor.providerId };
      } catch (error) {
        if (!stream.locked) await stream.cancel(error).catch(() => {});
        throw error;
      }
    });
  }

  private assertManagedTargetIdentity(control: ManagedObjectRestoreControl): void {
    if (
      control.component !== "discord"
      || control.kind !== "adapter_account"
      || this.env.DISCORD_GATEWAY.idFromName(control.logicalName).toString()
        !== this.ctx.id.toString()
    ) {
      throw new Error("Discord managed restore identity is invalid");
    }
  }

  private assertManagedPortableIdentity(
    component: string,
    kind: string,
    logicalName: string,
    providerId: string,
    fenceEpoch: number,
  ): void {
    if (
      component !== "discord"
      || kind !== "adapter_account"
      || providerId !== this.ctx.id.toString()
      || this.env.DISCORD_GATEWAY.idFromName(logicalName).toString() !== providerId
    ) {
      throw new Error("Discord managed portable identity is invalid");
    }
    this.lifecycle.assertPaused(fenceEpoch);
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
        managedLifecycle: this.lifecycle.snapshot(this.getAccountId()),
      },
    };
  }

  async sendMessage(message: {
    surface: ChannelPeer;
    text: string;
    media?: ChannelMedia[];
    replyToId?: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const epoch = this.lifecycle.activeEpoch();
    const botToken = this.state.botToken;
    if (!botToken) return { ok: false, error: "No bot token configured" };

    const body: Record<string, unknown> = {};
    const hasText = message.text.trim().length > 0;
    const media = message.media ?? [];
    if (!hasText && media.length === 0) {
      return { ok: false, error: "Discord messages require text or media" };
    }
    if (hasText) body.content = message.text;
    if (message.replyToId) {
      body.message_reference = { message_id: message.replyToId };
    }

    try {
      let requestBody: BodyInit;
      if (media.length > 0) {
        const form = new FormData();
        const attachments: Array<{ id: number; filename: string }> = [];
        for (const [index, attachment] of media.entries()) {
          const file = await this.prepareUploadFile(attachment, index, epoch);
          this.lifecycle.assertActive(epoch);
          form.append(`files[${index}]`, file.blob, file.filename);
          attachments.push({ id: index, filename: file.filename });
        }
        body.attachments = attachments;
        form.append("payload_json", JSON.stringify(body));
        requestBody = form;
      } else {
        requestBody = JSON.stringify(body);
      }

      const response = await this.discordFetch(
        `/channels/${message.surface.id}/messages`,
        { method: "POST", botToken, body: requestBody },
        epoch,
      );
      if (!response.ok) {
        const error = await response.text();
        this.lifecycle.assertActive(epoch);
        return {
          ok: false,
          error: `Discord API error: ${response.status} ${error}`,
        };
      }
      const data = await response.json<{ id: string }>();
      this.lifecycle.assertActive(epoch);
      return { ok: true, messageId: data.id };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async setTyping(surface: ChannelPeer): Promise<void> {
    const epoch = this.lifecycle.activeEpoch();
    if (!this.state.botToken) return;
    await this.discordFetch(
      `/channels/${surface.id}/typing`,
      { method: "POST", botToken: this.state.botToken },
      epoch,
    );
  }

  async react(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const epoch = this.lifecycle.activeEpoch();
    if (!this.state.botToken) {
      return { ok: false, error: "No bot token configured" };
    }
    const response = await this.discordFetch(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: "PUT", botToken: this.state.botToken },
      epoch,
    );
    if (response.ok) return { ok: true };
    const error = await response.text();
    this.lifecycle.assertActive(epoch);
    return {
      ok: false,
      error: `Discord API error: ${response.status} ${error}`,
    };
  }

  private async bindAccountId(accountId: string, epoch?: number): Promise<void> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    const normalized = accountId.trim();
    if (!normalized) throw new Error("Discord account ID is required");
    if (this.state.accountId && this.state.accountId !== normalized) {
      throw new Error("Discord account ID does not match durable account");
    }
    if (!this.state.accountId) {
      this.state.accountId = normalized;
      await this.saveState();
      if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    }
  }

  private async discordFetch(
    path: string,
    init: RequestInit & { botToken: string },
    epoch: number,
  ): Promise<Response> {
    this.lifecycle.assertActive(epoch);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bot ${init.botToken}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    let response = await fetch(`${DISCORD_API}${path}`, { ...init, headers });
    this.lifecycle.assertActive(epoch);
    if (response.status === 429) {
      const data = await response.json<{ retry_after?: number }>();
      this.lifecycle.assertActive(epoch);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil((data.retry_after ?? 1) * 1_000)),
      );
      this.lifecycle.assertActive(epoch);
      response = await fetch(`${DISCORD_API}${path}`, { ...init, headers });
      this.lifecycle.assertActive(epoch);
    }
    return response;
  }

  private async prepareUploadFile(
    media: ChannelMedia,
    index: number,
    epoch: number,
  ): Promise<{ blob: Blob; filename: string }> {
    this.lifecycle.assertActive(epoch);
    const filename =
      media.filename ||
      `attachment-${index + 1}.${this.getExtensionFromMime(media.mimeType, media.type)}`;
    if (media.data) {
      return {
        blob: new Blob([this.decodeBase64(media.data)], { type: media.mimeType }),
        filename,
      };
    }
    if (media.url) {
      const response = await fetch(media.url);
      this.lifecycle.assertActive(epoch);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch media from url (${response.status} ${response.statusText})`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      this.lifecycle.assertActive(epoch);
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
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
    return mapping[normalized] || (mediaType === "document" ? "bin" : mediaType);
  }
  
  /** Get the account ID name (e.g., "default"), falling back to hex DO id */
  private getAccountId(): string {
    return this.state.accountId ?? this.ctx.id.toString();
  }

  // ─────────────────────────────────────────────────────────
  // Alarm Handler (keep-alive + heartbeats)
  // ─────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const epoch = this.lifecycle.activeEpoch();
    // No token = not started, don't reschedule
    if (!this.state.botToken) {
      console.log("[DiscordGateway] No bot token, alarm stopping");
      return;
    }
    
    // Always reschedule to keep DO alive
    await this.scheduleKeepAlive(epoch);
    
    // Reconnect if WebSocket is gone
    if (!this.ws) {
      console.log("[DiscordGateway] WebSocket lost, reconnecting...");
      try {
        await this.openGatewayConnection(epoch);
        this.lifecycle.assertActive(epoch);
      } catch (e) {
        console.error("[DiscordGateway] Reconnect failed:", e);
        if (this.lifecycle.isActive(epoch)) {
          this.state.lastError = e instanceof Error ? e.message : String(e);
          await this.saveState();
        }
      }
      return;
    }
    
    // Send heartbeat if connected
    if (this.state.connected && this.heartbeatInterval > 0) {
      await this.sendHeartbeat(epoch, this.ws);
    }
  }
  
  private async scheduleKeepAlive(epoch: number): Promise<void> {
    this.lifecycle.assertActive(epoch);
    await this.ctx.storage.setAlarm(
      Date.now() + DiscordGateway.KEEP_ALIVE_INTERVAL_MS,
    );
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket Connection
  // ─────────────────────────────────────────────────────────

  private async openGatewayConnection(epoch: number): Promise<void> {
    this.lifecycle.assertActive(epoch);
    console.log("[DiscordGateway] Connecting...");

    // Get gateway URL
    let gatewayUrl = this.state.resumeGatewayUrl;
    if (!gatewayUrl) {
      const response = await fetch(DISCORD_GATEWAY_URL);
      const data = await response.json<{ url: string }>();
      this.lifecycle.assertActive(epoch);
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
    if (!this.lifecycle.isActive(epoch)) {
      if (ws) {
        ws.accept();
        ws.close(1001, "Managed lifecycle changed while opening socket");
      }
      this.lifecycle.assertActive(epoch);
    }
    if (!ws) {
      this.state.lastError = "Failed to establish WebSocket connection";
      await this.saveState();
      this.lifecycle.assertActive(epoch);
      throw new Error(this.state.lastError);
    }

    ws.accept();
    if (!this.lifecycle.isActive(epoch)) {
      ws.close(1001, "Managed lifecycle changed while opening socket");
      this.lifecycle.assertActive(epoch);
    }
    this.ws = ws;

    // Set up event handlers
    ws.addEventListener("message", (event) => {
      this.handleMessage(event.data as string, epoch, ws).catch((error) => {
        console.error("[DiscordGateway] Failed to handle gateway message:", error);
      });
    });
    ws.addEventListener("close", (event) => {
      this.handleClose(event, epoch, ws);
    });
    ws.addEventListener("error", (event) => {
      this.handleError(event, epoch, ws);
    });
  }

  private isCurrentSocket(epoch: number, socket: WebSocket): boolean {
    return this.lifecycle.isActive(epoch) && this.ws === socket;
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.ws;
    this.ws = null;
    if (socket) socket.close(code, reason);
  }

  private async handleMessage(
    rawData: string,
    epoch: number,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
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
          await this.resumeSession(epoch, socket);
        } else {
          await this.identify(epoch, socket);
        }
        break;

      case OP.HEARTBEAT_ACK:
        this.state.lastHeartbeatAck = Date.now();
        break;

      case OP.DISPATCH:
        await this.handleDispatch(t, d, epoch, socket);
        break;

      case OP.RECONNECT:
        console.log("[DiscordGateway] Received RECONNECT, reconnecting...");
        if (this.isCurrentSocket(epoch, socket)) {
          socket.close(4000, "Reconnect requested");
        }
        break;

      case OP.INVALID_SESSION:
        console.log("[DiscordGateway] Invalid session, re-identifying...");
        this.state.sessionId = null;
        this.state.seq = null;
        await this.saveState();
        this.lifecycle.assertActive(epoch);
        
        // Wait a bit before re-identifying (Discord docs recommend 1-5 seconds)
        await new Promise((r) => setTimeout(r, 2000));
        if (!this.isCurrentSocket(epoch, socket)) return;
        await this.identify(epoch, socket);
        break;
    }

    if (this.isCurrentSocket(epoch, socket)) {
      await this.saveState();
    }
  }

  private async handleDispatch(
    eventType: string,
    data: unknown,
    epoch: number,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
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
          if (!this.isCurrentSocket(epoch, socket)) return;
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
        }, epoch);
        if (!this.isCurrentSocket(epoch, socket)) return;
        
        await this.saveState();
        break;

      case "RESUMED":
        this.state.connected = true;
        this.state.lastError = null;
        console.log("[DiscordGateway] Session resumed");
        await this.saveState();
        break;

      case "MESSAGE_CREATE":
        await this.handleMessageCreate(d, epoch, socket);
        break;

      // Add more event handlers as needed
    }
  }

  private async handleMessageCreate(
    data: Record<string, unknown>,
    epoch: number,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    const author = data.author as { id: string; username: string; bot?: boolean; discriminator?: string } | undefined;
    
    // Ignore bot messages
    if (author?.bot) return;

    const content = typeof data.content === "string" ? data.content : "";
    const media = await this.extractMediaAttachments(data, epoch, socket);
    if (!this.isCurrentSocket(epoch, socket)) return;
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
    if (!this.isCurrentSocket(epoch, socket)) return;
    const wasMentioned = mentions?.some(m => m.id === botUser?.id) ?? false;
    const actorId = author ? `discord:user:${author.id}` : undefined;

    // Build inbound message
    const message: AdapterInboundMessage = {
      messageId,
      surface: {
        kind: guildId ? "group" : "dm",
        id: channelId,
        name: undefined, // Could fetch channel name
      },
      actor: author ? {
        id: actorId!,
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
      const result = await this.callGateway<AdapterInboundResult>(
        "adapter.inbound",
        {
          adapter: "discord",
          accountId: this.getAccountId(),
          message,
        },
      );
      if (!this.isCurrentSocket(epoch, socket)) return;
      if (!result.ok) {
        console.error(
          `[DiscordGateway] Inbound rejected by gateway: ${result.error ?? "unknown error"}`,
        );
        return;
      }
      if (result.challenge?.prompt) {
        await this.sendChannelText(
          channelId,
          result.challenge.prompt,
          messageReference?.message_id,
          epoch,
          socket,
        );
      }
      if (result.reply?.text) {
        await this.sendChannelText(
          channelId,
          result.reply.text,
          result.reply.replyToId || messageReference?.message_id,
          epoch,
          socket,
        );
      }
      console.log(
        `[DiscordGateway] Delivered message ${messageId} from ${author?.username}`,
      );
    } catch (e) {
      console.error("[DiscordGateway] Failed to deliver inbound via RPC:", e);
    }
  }

  private async notifyGatewayStatus(
    status: ChannelAccountStatus,
    epoch: number,
  ): Promise<void> {
    if (!this.lifecycle.isActive(epoch)) return;
    const accountId = this.getAccountId();
    try {
      await this.callGateway("adapter.state.update", {
        adapter: "discord",
        accountId,
        status,
      });
      this.lifecycle.assertActive(epoch);
    } catch (e) {
      console.error("[DiscordGateway] Failed to deliver status via RPC:", e);
    }
  }

  private async callGateway<T = unknown>(call: string, args: unknown): Promise<T> {
    const frame: GatewayRequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    };

    const response = await this.env.GATEWAY.serviceFrame(frame);
    if (!response || response.type !== "res") {
      throw new Error("No response from gateway serviceFrame");
    }
    if (!response.ok) {
      throw new Error(response.error?.message || `Gateway error on ${call}`);
    }

    return (response.data ?? {}) as T;
  }

  private async sendChannelText(
    channelId: string,
    text: string,
    replyToId: string | undefined,
    epoch: number,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    if (!this.state.botToken) return;
    const body: Record<string, unknown> = { content: text };
    if (replyToId) {
      body.message_reference = { message_id: replyToId };
    }

    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bot ${this.state.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      if (!this.isCurrentSocket(epoch, socket)) return;
      if (!response.ok) {
        console.warn(`[DiscordGateway] Failed to send challenge prompt: ${response.status}`);
      }
    } catch (e) {
      console.warn("[DiscordGateway] Error sending challenge prompt:", e);
    }
  }

  private async extractMediaAttachments(
    data: Record<string, unknown>,
    epoch: number,
    socket: WebSocket,
  ): Promise<ChannelMedia[]> {
    if (!Array.isArray(data.attachments)) {
      return [];
    }

    const media: ChannelMedia[] = [];
    for (const rawAttachment of data.attachments) {
      const attachment = this.parseAttachment(rawAttachment);
      if (!attachment) continue;

      const converted = await this.attachmentToMedia(attachment, epoch, socket);
      if (!this.isCurrentSocket(epoch, socket)) return [];
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
    epoch: number,
    socket: WebSocket,
  ): Promise<ChannelMedia | null> {
    if (!this.isCurrentSocket(epoch, socket)) return null;
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
      if (!this.isCurrentSocket(epoch, socket)) return null;
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
      if (!this.isCurrentSocket(epoch, socket)) return null;
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

  private async identify(epoch: number, socket: WebSocket): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    if (!this.state.botToken) {
      throw new Error("No bot token set");
    }

    const intents = 
      INTENTS.GUILDS |
      INTENTS.GUILD_MESSAGES |
      INTENTS.DIRECT_MESSAGES |
      INTENTS.MESSAGE_CONTENT;

    socket.send(JSON.stringify({
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

  private async resumeSession(epoch: number, socket: WebSocket): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    if (!this.state.botToken || !this.state.sessionId) {
      return this.identify(epoch, socket);
    }

    socket.send(JSON.stringify({
      op: OP.RESUME,
      d: {
        token: this.state.botToken,
        session_id: this.state.sessionId,
        seq: this.state.seq,
      },
    }));
  }

  private async sendHeartbeat(epoch: number, socket: WebSocket): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;

    socket.send(JSON.stringify({
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

  private handleClose(event: CloseEvent, epoch: number, socket: WebSocket): void {
    if (!this.isCurrentSocket(epoch, socket)) return;
    console.log(`[DiscordGateway] WebSocket closed: ${event.code} ${event.reason}`);
    this.ws = null;
    this.state.connected = false;

    // Attempt to reconnect for recoverable close codes
    const recoverableCodes = [4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009];
    if (recoverableCodes.includes(event.code) && this.state.botToken) {
      console.log("[DiscordGateway] Attempting to reconnect...");
      this.ctx.waitUntil(
        this.openGatewayConnection(epoch).catch((error) => {
          if (this.lifecycle.isActive(epoch)) {
            console.error("[DiscordGateway] Reconnect failed:", error);
          }
        }),
      );
    }
  }

  private handleError(event: Event, epoch: number, socket: WebSocket): void {
    if (!this.isCurrentSocket(epoch, socket)) return;
    console.error("[DiscordGateway] WebSocket error:", event);
    this.state.lastError = "WebSocket error";
  }
}
