/**
 * Discord Gateway Durable Object
 *
 * Maintains persistent WebSocket connection to Discord's Gateway API.
 * Handles IDENTIFY, HEARTBEAT, RESUME, and dispatches events to GSV Gateway.
 *
 * Based on: https://discord.com/developers/docs/topics/gateway
 */

import { DurableObject } from "cloudflare:workers";
import { shouldReplaceAlarm } from "../../shared/src/alarm";
import type { AdapterAccountStatus } from "../../shared/src/types";
import { discordHelloSchema, discordMessagePayloadSchema, discordReadyPayloadSchema, parseDiscordGatewayFrame, type DiscordDispatchPayload, type DiscordMessagePayload } from "./discord-events";

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

interface Env { DISCORD_API?: Fetcher; }

export abstract class DiscordGatewayTransport extends DurableObject<Env> {
  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000; // 10 seconds

  private ws: WebSocket | null = null;
  private readonly storage: DurableObjectStorage;
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
    this.storage = ctx.storage;
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
  protected providerFetch(): typeof fetch { return this.env.DISCORD_API ? this.env.DISCORD_API.fetch.bind(this.env.DISCORD_API) : fetch; }
  protected abstract connectionBotToken(): string | null;

  protected async startConnection(accountId?: string): Promise<void> {
    if (this.ws || this.opening) {
      console.log("[DiscordGateway] Already connected");
      return;
    }

    // Store the accountId name (not the hex DO id) for consistent inbound routing.
    if (accountId) {
      this.state.accountId = accountId;
    }
    await this.saveState();
    await this.openGatewayConnection();

    // Schedule keep-alive to prevent DO hibernation
    await this.scheduleKeepAlive();
  }

  async stop(): Promise<void> {
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
    if (!this.connectionBotToken()) {
      console.log("[DiscordGateway] No bot token, alarm stopping");
      return;
    }

    // The same alarm owns keep-alive, heartbeat, reconnect, and ingress retry.
    // Shared ingress retries are owned by DiscordPeer; this owner retains transport wakes.
    await this.scheduleKeepAlive();

    // Reconnect if WebSocket is gone
    if (!this.ws) {
      console.log("[DiscordGateway] WebSocket lost, reconnecting...");
      try {
        await this.openGatewayConnection();
      } catch (e) {
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
    const alarmAt = Date.now() + DiscordGatewayTransport.KEEP_ALIVE_INTERVAL_MS;
    await this.storage.transaction(async (txn) => {
      if (shouldReplaceAlarm(await txn.getAlarm(), alarmAt, Date.now())) await txn.setAlarm(alarmAt);
    });
  }

  // ─────────────────────────────────────────────────────────
  // WebSocket Connection
  // ─────────────────────────────────────────────────────────

  private async openGatewayConnection(): Promise<void> {
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
  protected abstract handleMessageCreate(data: DiscordMessagePayload): Promise<void>;
  protected abstract notifyGatewayStatus(status: AdapterAccountStatus): Promise<void>;
  protected abstract connectionIntents(): number;

  private async identify() {
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
