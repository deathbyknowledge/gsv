/**
 * Discord Gateway Durable Object
 * 
 * Maintains persistent WebSocket connection to Discord's Gateway API.
 * Handles IDENTIFY, HEARTBEAT, RESUME, and dispatches events to GSV Gateway.
 * 
 * Based on: https://discord.com/developers/docs/topics/gateway
 */

import { DurableObject } from "cloudflare:workers";
import type { InstallationDeletionReceipt, InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";
import type { AdapterResourceInspection } from "../../shared/src/peer-retirement";
import { cancelBinaryBody } from "../../shared/src/media-body";
import { DiscordAccountRetirement } from "./discord-account-retirement";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
} from "../../shared/src/inbound-delivery";
import { callAdapterGateway } from "../../shared/src/gateway-rpc";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  assertAdapterAccountDurableObjectIdentity,
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  resolveAdapterAccountDurableObjectIdentity,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterInboundMessage,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSendResult,
  BinaryBody,
} from "../../shared/src/types";
import { extractDiscordMedia } from "./discord-inbound-media";
import { deliverDiscordMessage } from "./discord-delivery";
import {
  discordHelloSchema, discordMessagePayloadSchema, discordReadyPayloadSchema,
  parseDiscordGatewayFrame, type DiscordDispatchPayload, type DiscordMessagePayload,
} from "./discord-events";

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

const INBOUND_DELIVERY_PREFIX = "pending_inbound:";
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 25;

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
  GATEWAY: Fetcher & AdapterGatewayBinding;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_API?: Fetcher;
  DISCORD_GATEWAY?: Pick<DurableObjectNamespace, "idFromName">;
}

export class DiscordGateway extends DurableObject<Env> {
  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000; // 10 seconds
  
  private ws: WebSocket | null = null;
  private readonly retirement: DiscordAccountRetirement;
  private readonly storage: DurableObjectStorage;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<string>;
  private heartbeatInterval: number = 0;
  private opening?: Promise<void>;
  private connectionEpoch = 0;
  private incoming: Promise<void> = Promise.resolve();
  private loaded = false;
  protected state: GatewayState = {
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
    this.retirement = new DiscordAccountRetirement(ctx.storage, ctx.id.toString(), env.DISCORD_GATEWAY);
    this.storage = this.retirement.guardStorage();
    this.deliveries = new DeliveryLedger(this.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.storage,
      INBOUND_DELIVERY_PREFIX,
    );
    this.ctx.blockConcurrencyWhile(async () => this.loadState());
  }

  protected async loadState() {
    if (this.loaded) return;
    const stored = await this.storage.get<GatewayState>("state");
    if (stored) {
      this.state = { ...this.state, ...stored };
    }
    this.loaded = true;
  }

  protected async saveState() {
    await this.storage.put("state", this.state);
  }

  // ─────────────────────────────────────────────────────────
  // Public RPC Methods (called by WorkerEntrypoint)
  // ─────────────────────────────────────────────────────────

  async start(botToken: string, accountId?: string): Promise<void> {
    using _operation = this.retirement.operation();
    await this.loadState();
    const storedIdentity = this.retirement.identity();
    const normalizedAccountId = accountId
      ? assertAdapterAccountDurableObjectIdentity(
          this.ctx.id.name,
          accountId,
          {
            installationId: storedIdentity?.installationId ?? (this.ctx.id.name
              ? undefined
              : LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID),
            accountId: this.state.accountId,
          },
        ).accountId
      : undefined;
    await this.startConnection(normalizedAccountId, botToken);
  }

  protected providerFetch(): typeof fetch {
    const provider = this.env.DISCORD_API ? this.env.DISCORD_API.fetch.bind(this.env.DISCORD_API) : fetch;
    return async (input, init) => {
      this.retirement.requireLive();
      const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = inputSignal ? AbortSignal.any([inputSignal, this.retirement.signal]) : this.retirement.signal;
      const response = await provider(input, { ...init, signal });
      if (this.retirement.retired) {
        if (response.webSocket) { response.webSocket.accept(); response.webSocket.close(1000, "Installation retired"); }
        else await response.body?.cancel("Installation retired").catch(() => {});
        this.retirement.requireLive();
      }
      return response;
    };
  }

  protected connectionBotToken(): string | null { return this.state.botToken ?? this.env.DISCORD_BOT_TOKEN ?? null; }

  protected async startConnection(accountId?: string, botToken?: string): Promise<void> {
    using _operation = this.retirement.operation();
    if (this.ws || this.opening) {
      console.log("[DiscordGateway] Already connected");
      return;
    }

    // Store the accountId name (not the hex DO id) for consistent inbound routing.
    if (accountId) {
      this.state.accountId = accountId;
    }
    if (botToken !== undefined) this.state.botToken = botToken;
    await this.saveState();
    await this.openGatewayConnection();
    
    // Schedule keep-alive to prevent DO hibernation
    await this.scheduleKeepAlive();
  }

  async stop(): Promise<void> {
    using _operation = this.retirement.operation();
    await this.loadState();
    this.connectionEpoch++;
    if (this.ws) {
      this.ws.close(1000, "Stopped by user");
      this.ws = null;
    }
    this.state.connected = false;
    await this.saveState();
    await this.storage.deleteAlarm();
  }

  async getStatus(): Promise<AdapterAccountStatus> {
    await this.loadState();
    const extra: NonNullable<AdapterAccountStatus["extra"]> = {};
    if (this.state.sessionId !== undefined) extra.sessionId = this.state.sessionId;
    if (this.state.seq !== undefined) extra.seq = this.state.seq;
    return {
      accountId: this.getAccountId(),
      connected: this.state.connected,
      authenticated: !!this.state.sessionId,
      mode: "gateway",
      lastActivity: this.state.lastHeartbeatAck ?? undefined,
      error: this.state.lastError ?? undefined,
      extra,
    };
  }

  async getBotToken(): Promise<string | null> {
    await this.loadState();
    return this.retirement.retired ? null : this.state.botToken;
  }

  async sendMessage(
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    if (this.retirement.retired) {
      await cancelBinaryBody(body, "Discord account installation is retired");
      return { ok: false, error: "Discord account installation is retired" };
    }
    using _operation = this.retirement.operation();
    try {
      await this.loadState();
      return await deliverDiscordMessage(
        this.deliveries,
        this.state.botToken || this.env.DISCORD_BOT_TOKEN || null,
        message,
        body,
        { providerFetch: this.providerFetch(), signal: this.retirement.signal, isCurrent: async () => !this.retirement.retired },
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
  }

  async inspectInstallationResource(targetInstallationId: string, candidateInstallationIds?: string[]): Promise<AdapterResourceInspection> {
    return this.retirement.inspect(targetInstallationId, candidateInstallationIds);
  }

  async quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    return await this.retirement.quiesce(input, () => {
      this.connectionEpoch++;
      const socket = this.ws;
      this.ws = null;
      socket?.close(1000, "Installation retired");
      this.state.connected = false;
      this.state.botToken = null;
    });
  }

  async eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    await this.quiesceInstallation(input);
    const receipt = this.retirement.erase(input);
    if (receipt.phase === "live-erased" || receipt.phase === "erased") {
      this.state = { accountId: null, botToken: null, sessionId: null, resumeGatewayUrl: null, seq: null, connected: false, lastHeartbeatAck: null, lastError: null };
    }
    return receipt;
  }

  async installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt> {
    return this.retirement.status(input);
  }

  /** Get the account ID name (e.g., "default"), falling back to hex DO id */
  private getAccountId(): string {
    return this.state.accountId ?? this.ctx.id.toString();
  }

  private getInstallationContext(): AdapterInstallationContext {
    this.retirement.requireLive();
    const storedIdentity = this.retirement.identity();
    if (storedIdentity) return { installationId: storedIdentity.installationId };
    const identity = resolveAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      {
        installationId: this.ctx.id.name
          ? undefined
          : LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
        accountId: this.state.accountId,
      },
    );
    return { installationId: identity.installationId };
  }

  // ─────────────────────────────────────────────────────────
  // Alarm Handler (keep-alive + heartbeats)
  // ─────────────────────────────────────────────────────────

  async alarm() {
    if (this.retirement.retired) return;
    using _operation = this.retirement.operation();
    // Reload state in case we hibernated
    await this.loadState();

    // An alarm is cleared when it starts. Persist the next wake-up before any
    // retry performs external I/O so a crash cannot strand durable ingress.
    await this.inboundDeliveries.armIfPending(
      Date.now() + INBOUND_RETRY_DELAY_MS,
    );
    await this.retryPendingInbound();

    // No token = not started, don't reschedule
    if (!this.connectionBotToken()) {
      console.log("[DiscordGateway] No bot token, alarm stopping");
      return;
    }

    // The same alarm owns keep-alive, heartbeat, reconnect, and ingress retry.
    await this.scheduleKeepAlive();

    // Reconnect if WebSocket is gone
    if (!this.ws) {
      console.log("[DiscordGateway] WebSocket lost, reconnecting...");
      try {
        await this.openGatewayConnection();
      } catch (e) {
        if (this.retirement.retired) return;
        console.error("[DiscordGateway] Reconnect failed:", e);
        this.state.lastError = e instanceof Error ? e.message : String(e);
        await this.saveState();
      }
    } else if (this.state.connected && this.heartbeatInterval > 0) {
      // Send heartbeat if connected
      await this.sendHeartbeat();
    }
  }
  
  protected async scheduleKeepAlive(): Promise<void> {
    await this.inboundDeliveries.arm(
      Date.now() + DiscordGateway.KEEP_ALIVE_INTERVAL_MS,
    );
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket Connection
  // ─────────────────────────────────────────────────────────

  private async openGatewayConnection(): Promise<void> {
    using _operation = this.retirement.operation();
    if (this.opening) return await this.opening;
    const epoch = this.connectionEpoch;
    const opening = this.connectGateway(epoch);
    this.opening = opening;
    try { await opening; } finally { if (this.opening === opening) this.opening = undefined; }
  }

  private async connectGateway(epoch: number) {
    console.log("[DiscordGateway] Connecting...");

    // Get gateway URL
    let gatewayUrl = this.state.resumeGatewayUrl;
    if (!gatewayUrl) {
      const response = await this.providerFetch()(DISCORD_GATEWAY_URL);
      const data = await response.json<{ url: string }>();
      gatewayUrl = data.url;
    }

    if (epoch !== this.connectionEpoch) return;

    // Parse and modify URL for WebSocket
    const url = new URL(gatewayUrl);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");

    // Open WebSocket connection
    const response = await this.providerFetch()(url.toString().replace("wss://", "https://"), {
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
    if (epoch !== this.connectionEpoch) { ws.close(1000, "Connection superseded"); return; }
    this.ws = ws;

    // Set up event handlers
    ws.addEventListener("message", (event) => {
      this.incoming = this.incoming.then(async () => {
        if (this.ws === ws) await this.handleMessage(event.data, ws);
      }).catch(() => {
        if (this.ws !== ws) return;
        ws.close(4000, "Gateway dispatch failed");
        this.ws = null;
        this.state.connected = false;
      });
      this.ctx.waitUntil(this.incoming);
    });
    ws.addEventListener("close", (event) => { if (this.ws === ws) this.handleClose(event); });
    ws.addEventListener("error", (event) => { if (this.ws === ws) this.handleError(event); });
  }

  private async handleMessage(rawData: string, socket: WebSocket) {
    using _operation = this.retirement.operation();
    const payload = parseDiscordGatewayFrame(rawData);
    const { op, t, d, s } = payload;

    switch (op) {
      case OP.HELLO:
        this.heartbeatInterval = discordHelloSchema.parse(d).heartbeat_interval;
        await this.scheduleHeartbeat();
        
        if (this.ws !== socket) return;

        // IDENTIFY or RESUME
        if (this.state.sessionId && this.state.seq !== null) {
          await this.resume();
        } else {
          await this.identify();
        }
        break;

      case OP.HEARTBEAT:
        await this.sendHeartbeat();
        break;

      case OP.HEARTBEAT_ACK:
        this.state.lastHeartbeatAck = Date.now();
        break;

      case OP.DISPATCH:
        await this.handleDispatch(t ?? "", d);
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
        if (this.ws !== socket) return;
        await this.identify();
        break;
    }

    if (this.ws !== socket) return;

    // Track sequence number
    // Persist it only after its owner has durably accepted the dispatch.
    if (s !== null && s !== undefined) this.state.seq = s;
    await this.saveState();
  }

  protected async handleDispatch(eventType: string, d: DiscordDispatchPayload) {
    using _operation = this.retirement.operation();

    switch (eventType) {
      case "READY":
        {
        const ready = discordReadyPayloadSchema.parse(d);
        this.state.sessionId = ready.session_id;
        this.state.resumeGatewayUrl = ready.resume_gateway_url;
        this.state.connected = true;
        this.state.lastError = null;
        
        // Store bot user info for mention detection
        const botUser = ready.user;
        if (botUser) {
          await this.storage.put("botUser", { id: botUser.id, username: botUser.username });
        }
        
        console.log(`[DiscordGateway] Connected as ${botUser?.username} (${botUser?.id})`);
        
        // Notify Gateway of status change via Service Binding RPC.
        const accountId = this.getAccountId();
        const extra: NonNullable<AdapterAccountStatus["extra"]> = {};
        if (botUser) {
          extra.botUserId = botUser.id;
          extra.botUsername = botUser.username;
        }
        await this.notifyGatewayStatus({
          accountId,
          connected: true,
          authenticated: true,
          mode: "gateway",
          extra,
        });
        
        await this.saveState();
        break;
        }

      case "RESUMED":
        this.state.connected = true;
        this.state.lastError = null;
        console.log("[DiscordGateway] Session resumed");
        await this.saveState();
        break;

      case "MESSAGE_CREATE":
        await this.handleMessageCreate(discordMessagePayloadSchema.parse(d));
        break;

      // Add more event handlers as needed
    }
  }

  protected async handleMessageCreate(data: DiscordMessagePayload): Promise<void> {
    using _operation = this.retirement.operation();
    const author = data.author;

    // Ignore bot messages
    if (author?.bot) return;

    const content = data.content ?? "";
    const hasAttachments = (data.attachments?.length ?? 0) > 0;
    if (!content && !hasAttachments) return;

    const messageId = data.id;

    await this.inboundDeliveries.enqueueAndArm(
      messageId,
      JSON.stringify(data),
      Date.now() + INBOUND_RETRY_DELAY_MS,
    );
    await this.deliverPendingInbound(messageId);
  }

  private async deliverPendingInbound(messageId: string): Promise<void> {
    using _operation = this.retirement.operation();
    const attempt = await this.inboundDeliveries.attempt(
      messageId,
      async (serialized) => this.forwardMessageCreate(
        discordMessagePayloadSchema.parse(JSON.parse(serialized)),
      ),
      async (response) => this.sendMessage(response),
    );
    if (attempt.state !== "pending") return;

    this.state.lastError = attempt.error ?? "Gateway receipt is still in progress";
    await this.saveState();
    console.error(
      `[DiscordGateway] Inbound ${messageId} remains pending: ${this.state.lastError}`,
    );
    await this.inboundDeliveries.arm(Date.now() + INBOUND_RETRY_DELAY_MS);
  }

  private async retryPendingInbound(): Promise<void> {
    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const messageId of ids) {
      await this.deliverPendingInbound(messageId);
    }
  }

  private async forwardMessageCreate(
    data: DiscordMessagePayload,
  ): Promise<{ terminal: boolean; error?: string }> {
    const author = data.author;
    const content = data.content ?? "";
    const guildId = data.guild_id;
    const channelId = data.channel_id;
    const messageId = data.id;
    const messageReference = data.message_reference;

    // Check if bot was mentioned
    const mentions = data.mentions ?? [];
    const botUser = await this.storage.get<{ id: string }>("botUser");
    const referencedMessage = data.referenced_message;
    const botUserId = botUser?.id;
    const wasMentioned = Boolean(
      botUserId
      && (
        mentions.some((mention) => mention.id === botUserId)
        || referencedMessage?.author?.id === botUserId
      ),
    );
    const actorId = author ? `discord:user:${author.id}` : undefined;
    const media = await extractDiscordMedia(data, this.providerFetch());

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
      text: content || (media.media.length > 0 ? "[Media]" : "[Media unavailable]"),
      media: media.media.length > 0 ? media.media : undefined,
      replyToId:
        messageReference?.message_id,
      timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
      wasMentioned,
    };

    if (this.retirement.retired) {
      await cancelBinaryBody(media.body, "Discord account installation is retired");
      this.retirement.requireLive();
    }
    const result = await callAdapterGateway(
      this.env.GATEWAY,
      this.getInstallationContext(),
      "adapter.inbound",
      {
        adapter: "discord",
        accountId: this.getAccountId(),
        deliveryId: messageId,
        message,
      },
      media.body,
    );
    const responseDisposition = adapterInboundResultDisposition(result, {
      surface: message.surface,
      providerMessageId: messageId,
    });
    if (!responseDisposition.terminal) return responseDisposition;
    if (!result.ok) {
      console.error(
        `[DiscordGateway] Inbound rejected by gateway: ${result.error ?? "unknown error"}`,
      );
      return responseDisposition;
    }

    this.state.lastError = null;
    console.log(
      `[DiscordGateway] Delivered message ${messageId} from ${author?.username}`,
    );
    return responseDisposition;
  }

  protected async notifyGatewayStatus(status: AdapterAccountStatus): Promise<void> {
    this.retirement.requireLive();
    const accountId = this.getAccountId();
    try {
      await callAdapterGateway(
        this.env.GATEWAY,
        this.getInstallationContext(),
        "adapter.state.update",
        {
          adapter: "discord",
          accountId,
          status,
        },
      );
    } catch (e) {
      console.error("[DiscordGateway] Failed to deliver status via RPC:", e);
    }
  }

  protected connectionIntents(): number {
    return INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT;
  }

  private async identify() {
    this.retirement.requireLive();
    const token = this.connectionBotToken();
    if (!token) {
      throw new Error("No bot token set");
    }

    this.ws?.send(JSON.stringify({
      op: OP.IDENTIFY,
      d: {
        token,
        intents: this.connectionIntents(),
        properties: {
          os: "cloudflare",
          browser: "gsv",
          device: "gsv",
        },
      },
    }));
  }

  private async resume() {
    this.retirement.requireLive();
    const token = this.connectionBotToken();
    if (!token || !this.state.sessionId) {
      return this.identify();
    }

    this.ws?.send(JSON.stringify({
      op: OP.RESUME,
      d: {
        token,
        session_id: this.state.sessionId,
        seq: this.state.seq,
      },
    }));
  }

  private async sendHeartbeat() {
    this.retirement.requireLive();
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
    if (recoverableCodes.includes(event.code) && this.connectionBotToken()) {
      console.log("[DiscordGateway] Attempting to reconnect...");
      this.ctx.waitUntil(this.openGatewayConnection());
    }
  }

  private handleError(event: Event) {
    console.error("[DiscordGateway] WebSocket error:", event);
    this.state.lastError = "WebSocket error";
  }
}
