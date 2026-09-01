import { DurableObject } from "cloudflare:workers";
import { DeliveryLedger } from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
} from "../../shared/src/inbound-delivery";
import {
  AdapterPeerDeliveryQueue,
  gatewayPeerDeliveryHandlers,
  type AdapterPeerSignalDelivery,
} from "../../shared/src/peer-delivery";
import { renderAdapterPeerSignal } from "../../shared/src/peer-render";
import { runAdapterPeerSqlMigrations } from "../../shared/src/schema/migrations";
import { callAdapterGateway, type AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  assertAdapterAccountDurableObjectIdentity,
  resolveAdapterAccountDurableObjectIdentity,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterPeerSignalFrame,
  AdapterSendResult,
  BinaryBody,
} from "./types";
import {
  authenticateSlackBot,
  downloadSlackFile,
  openSlackSocket,
  requireSlackToken,
  SlackApiError,
  updateSlackMessage,
  type SlackFetch,
} from "./slack-api";
import { deliverSlackMessage } from "./slack-delivery";
import {
  attachSlackApprovalMessage,
  handleSlackApprovalCallback,
  prepareSlackApproval,
} from "./slack-approval";
import {
  appendSlackMediaNotice,
  loadSlackInboundMedia,
} from "./slack-media";
import {
  normalizeSlackInteraction,
  type SlackApprovalCallback,
  type SlackBlock,
} from "./slack-interactions";
import {
  normalizeSlackEvent,
  type SlackInbound,
} from "./slack-events";
import { z } from "zod";

interface Env {
  GATEWAY: Fetcher & AdapterGatewayBinding;
  SLACK_API?: Fetcher;
  SLACK_SOCKET?: Fetcher;
}

type SlackAccountState = {
  version: 1;
  installationId: string | null;
  accountId: string;
  botToken: string | null;
  appToken: string | null;
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  connected: boolean;
  authenticated: boolean;
  lastActivity: number | null;
  lastError: string | null;
};

const socketEnvelopeSchema = z.object({
  type: z.string(),
  envelope_id: z.string().optional(),
  payload: z.unknown().optional(),
  reason: z.string().optional(),
}).passthrough();

const STATE_KEY = "slack_account:v1:state";
const INBOUND_PREFIX = "slack_account:v1:inbound:";
const INBOUND_WAKE_DELAY_MS = 25;
const RETRY_DELAY_MS = 10_000;
const KEEP_ALIVE_MS = 30_000;
const INBOUND_BATCH_SIZE = 25;
const MAX_SOCKET_FRAME_BYTES = 1024 * 1024;

export class SlackAccount extends DurableObject<Env> {
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<SlackInbound | SlackApprovalCallback>;
  private readonly peerDeliveries: AdapterPeerDeliveryQueue;
  private state: SlackAccountState = {
    version: 1,
    installationId: null,
    accountId: "default",
    botToken: null,
    appToken: null,
    teamId: null,
    teamName: null,
    botUserId: null,
    connected: false,
    authenticated: false,
    lastActivity: null,
    lastError: null,
  };
  private loaded = false;
  private socket: WebSocket | null = null;
  private drainPromise?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runAdapterPeerSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_PREFIX,
      { completedRetentionMs: 7 * 24 * 60 * 60 * 1000, maxRecords: 4_096 },
    );
    this.peerDeliveries = new AdapterPeerDeliveryQueue(this.ctx.storage, RETRY_DELAY_MS);
  }

  async start(botTokenInput: string, appTokenInput: string, accountId: string): Promise<void> {
    await this.ensureLoaded();
    const identity = assertAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      accountId,
      this.state,
    );
    const botToken = requireSlackToken(botTokenInput, "Slack bot token", "xoxb-");
    const appToken = requireSlackToken(appTokenInput, "Slack app token", "xapp-");
    const bot = await authenticateSlackBot(botToken, this.slackFetch());
    const credentialsChanged = this.state.botToken !== botToken
      || this.state.appToken !== appToken
      || this.state.teamId !== bot.teamId;
    if (credentialsChanged) await this.inboundDeliveries.clear();
    this.closeSocket(1000, "Slack account restarted");
    this.state = {
      version: 1,
      installationId: identity.installationId,
      accountId: identity.accountId,
      botToken,
      appToken,
      teamId: bot.teamId,
      teamName: bot.teamName ?? null,
      botUserId: bot.botUserId,
      connected: false,
      authenticated: true,
      lastActivity: Date.now(),
      lastError: null,
    };
    await this.saveState();
    try {
      await this.openSocket();
    } catch (error) {
      this.state.connected = false;
      this.state.lastError = "Slack Socket Mode connection failed";
      await this.saveState();
      await this.scheduleWake(Date.now() + RETRY_DELAY_MS);
      await this.notifyStatus();
      throw error;
    }
    await this.notifyStatus();
  }

  async stop(): Promise<void> {
    await this.ensureLoaded();
    this.closeSocket(1000, "Slack account disconnected");
    await this.inboundDeliveries.clear();
    this.state = {
      ...this.state,
      botToken: null,
      appToken: null,
      connected: false,
      authenticated: false,
      lastError: null,
    };
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(STATE_KEY, this.state);
      await txn.deleteAlarm();
    });
    await this.peerDeliveries.armIfPending(Date.now() + RETRY_DELAY_MS);
    await this.notifyStatus();
  }

  async getStatus(): Promise<AdapterAccountStatus> {
    await this.ensureLoaded();
    const extra: NonNullable<AdapterAccountStatus["extra"]> = {};
    if (this.state.teamId) extra.teamId = this.state.teamId;
    if (this.state.teamName) extra.teamName = this.state.teamName;
    if (this.state.botUserId) extra.botUserId = this.state.botUserId;
    return {
      accountId: this.state.accountId,
      connected: this.state.connected,
      authenticated: this.state.authenticated,
      mode: "socket-mode",
      lastActivity: this.state.lastActivity ?? undefined,
      error: this.state.lastError ?? undefined,
      extra,
    };
  }

  async sendMessage(
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    blocks?: SlackBlock[],
  ): Promise<AdapterSendResult> {
    await this.ensureLoaded();
    return await deliverSlackMessage(
      this.deliveries,
      this.state.botToken,
      message,
      body,
      {
        slackFetch: this.slackFetch(),
        attributedActorId: message.surface.kind === "dm" ? undefined : message.actorId,
        blocks,
      },
    );
  }

  async acceptPeerSignal(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: AdapterPeerSignalFrame,
    body?: BinaryBody,
  ): Promise<void> {
    await this.ensureLoaded();
    if (context.accountId !== this.state.accountId) {
      await cancelBinaryBody(body, "Slack account changed before signal acceptance");
      throw new Error("Slack account changed before signal acceptance");
    }
    await this.peerDeliveries.enqueueAndArm(
      { installation, context, frame },
      body,
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    this.ctx.waitUntil(this.drainPeerDeliveries());
  }

  private async drainPeerDeliveries(): Promise<void> {
    await this.peerDeliveries.drain(gatewayPeerDeliveryHandlers({
      adapter: "slack",
      gateway: this.env.GATEWAY,
      deliver: async (delivery, body) => await this.deliverPeerSignal(delivery, body),
    }));
  }

  private async deliverPeerSignal(
    delivery: AdapterPeerSignalDelivery,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    const rendered = renderAdapterPeerSignal(delivery.context, delivery.frame).message;
    const controls = delivery.frame.signal === "proc.run.hil.requested" && this.state.teamId
      ? await prepareSlackApproval(
          this.ctx.storage,
          this.state.teamId,
          delivery.context,
          delivery.frame.payload,
          rendered.text,
        )
      : null;
    const result = await this.sendMessage(rendered, body, controls?.blocks);
    if (result.ok && controls) {
      await attachSlackApprovalMessage(this.ctx.storage, controls.token, result.messageId);
    }
    return result;
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    await this.peerDeliveries.armIfPending(Date.now() + RETRY_DELAY_MS);
    await this.drainPeerDeliveries();
    await this.drainInbound();
    await this.inboundDeliveries.armIfPending(Date.now() + RETRY_DELAY_MS);
    if (!this.state.botToken || !this.state.appToken) return;
    if (!this.socket) {
      try {
        await this.openSocket();
      } catch {
        this.state.connected = false;
        this.state.lastError = "Slack Socket Mode reconnect failed";
        await this.saveState();
        await this.scheduleWake(Date.now() + RETRY_DELAY_MS);
        await this.notifyStatus();
        return;
      }
      await this.notifyStatus();
    }
    await this.scheduleWake(Date.now() + KEEP_ALIVE_MS);
  }

  private async openSocket(): Promise<void> {
    const appToken = this.state.appToken;
    if (!appToken) throw new Error("Slack app token is not configured");
    const socketUrl = await openSlackSocket(appToken, this.slackFetch());
    const url = new URL(socketUrl);
    url.protocol = "https:";
    const response = this.env.SLACK_SOCKET
      ? await this.env.SLACK_SOCKET.fetch(url, { headers: { Upgrade: "websocket" } })
      : await fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Slack Socket Mode upgrade failed");
    socket.accept();
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.ctx.waitUntil(this.handleSocketMessage(socket, event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ctx.waitUntil(this.handleSocketClosed());
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ctx.waitUntil(this.handleSocketClosed());
    });
    this.state.connected = true;
    this.state.lastError = null;
    this.state.lastActivity = Date.now();
    await this.saveState();
    await this.scheduleWake(Date.now() + KEEP_ALIVE_MS);
  }

  private async handleSocketMessage(
    source: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    if (this.socket !== source) return;
    const text = raw instanceof ArrayBuffer
      ? raw.byteLength <= MAX_SOCKET_FRAME_BYTES
        ? new TextDecoder().decode(raw)
        : ""
      : raw;
    if (!text || new TextEncoder().encode(text).byteLength > MAX_SOCKET_FRAME_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = socketEnvelopeSchema.safeParse(value);
    if (!parsed.success) return;
    const envelope = parsed.data;
    this.state.lastActivity = Date.now();

    if (envelope.type === "disconnect") {
      this.closeSocket(1000, "Slack requested reconnect");
      this.state.connected = false;
      this.state.lastError = "Slack requested a Socket Mode reconnect";
      await this.saveState();
      await this.scheduleWake(Date.now() + 100);
      await this.notifyStatus();
      return;
    }
    if (envelope.type === "hello") {
      await this.saveState();
      return;
    }
    if (!envelope.envelope_id) return;
    if (envelope.type === "interactive" && envelope.payload) {
      const botUserId = this.state.botUserId;
      if (!botUserId) return;
      const interaction = normalizeSlackInteraction(envelope.payload, botUserId);
      let enqueued = false;
      if (
        interaction.kind === "accepted"
        && interaction.callback.teamId === this.state.teamId
      ) {
        await this.inboundDeliveries.enqueueAndArm(
          interaction.callback.deliveryId,
          interaction.callback,
          Date.now() + INBOUND_WAKE_DELAY_MS,
        );
        enqueued = true;
      }
      source.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      if (enqueued) this.ctx.waitUntil(this.drainInbound());
      return;
    }
    if (envelope.type !== "events_api" || !envelope.payload) {
      source.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      return;
    }

    const botUserId = this.state.botUserId;
    if (!botUserId) return;
    const disposition = normalizeSlackEvent(envelope.payload, botUserId);
    let uninstalled = false;
    if (disposition.kind === "accepted" && disposition.inbound.teamId === this.state.teamId) {
      await this.inboundDeliveries.enqueueAndArm(
        disposition.inbound.deliveryId,
        disposition.inbound,
        Date.now() + INBOUND_WAKE_DELAY_MS,
      );
    } else if (disposition.kind === "uninstalled" && disposition.teamId === this.state.teamId) {
      this.state.authenticated = false;
      this.state.connected = false;
      this.state.botToken = null;
      this.state.appToken = null;
      await this.inboundDeliveries.clear();
      await this.saveState();
      uninstalled = true;
    }

    try {
      source.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    } finally {
      if (uninstalled) {
        this.closeSocket(1000, "Slack app uninstalled");
        await this.notifyStatus();
      }
    }
    if (disposition.kind === "accepted") this.ctx.waitUntil(this.drainInbound());
  }

  private async drainInbound(): Promise<void> {
    if (this.drainPromise) return await this.drainPromise;
    const running = (async () => {
      const recoveryError = this.state.lastError;
      const ids = await this.inboundDeliveries.pendingIds(INBOUND_BATCH_SIZE);
      let batchCompleted = ids.length > 0;
      for (const id of ids) {
        const result = await this.inboundDeliveries.attempt(
          id,
          async (inbound) => await this.forwardInbound(inbound),
          async (message) => await this.sendMessage(message),
        );
        if (result.state === "pending") {
          batchCompleted = false;
          this.state.lastError = result.error ?? "Slack ingress remains pending";
          await this.saveState();
          await this.notifyStatus();
          await this.inboundDeliveries.arm(Date.now() + RETRY_DELAY_MS);
          break;
        }
        if (result.state === "active") batchCompleted = false;
      }
      if (
        batchCompleted
        && recoveryError !== null
        && this.state.connected
        && this.state.lastError === recoveryError
      ) {
        this.state.lastError = null;
        await this.saveState();
        await this.notifyStatus();
      }
    })();
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = undefined;
    }
  }

  private async forwardInbound(inbound: SlackInbound | SlackApprovalCallback) {
    if ("interactionId" in inbound) {
      const botToken = this.state.botToken;
      if (!botToken || inbound.teamId !== this.state.teamId) return { terminal: true };
      // The durable approval delivery is authoritative; clearing buttons is best effort.
      await handleSlackApprovalCallback(
        this.ctx.storage,
        this.env.GATEWAY,
        this.installationContext(),
        inbound,
        {
          updateMessage: async (callback, message) => {
            await updateSlackMessage(botToken, {
              channel: callback.surface.id,
              messageTs: callback.sourceMessageId,
              ...message,
            }, this.slackFetch());
          },
        },
      );
      return { terminal: true };
    }
    if (inbound.teamId !== this.state.teamId) return { terminal: true };
    const botToken = this.state.botToken;
    if (!botToken) return { terminal: true };
    const transfer = await loadSlackInboundMedia(
      inbound.media ?? [],
      async (fileId, maxBytes) => {
        try {
          return await downloadSlackFile(
            botToken,
            fileId,
            maxBytes,
            this.slackFetch(),
          );
        } catch (error) {
          if (error instanceof SlackApiError && error.kind === "permanent") return null;
          throw error;
        }
      },
    );
    const skipped = (inbound.skippedMedia ?? 0) + transfer.skipped;
    if (this.state.botToken !== botToken || inbound.teamId !== this.state.teamId) {
      await cancelBinaryBody(transfer.body, "Slack account changed before media delivery");
      return { terminal: true };
    }
    const result = await callAdapterGateway(
      this.env.GATEWAY,
      this.installationContext(),
      "adapter.inbound",
      {
        adapter: "slack",
        accountId: this.state.accountId,
        deliveryId: inbound.deliveryId,
        message: {
          messageId: inbound.messageId,
          surface: inbound.surface,
          actor: { id: inbound.actorId },
          text: appendSlackMediaNotice(inbound.text, skipped),
          media: transfer.media.length > 0 ? transfer.media : undefined,
          replyToId: inbound.replyToId,
          timestamp: inbound.timestamp,
          wasMentioned: true,
        },
      },
      transfer.body,
    );
    const disposition = adapterInboundResultDisposition(result, {
      surface: inbound.surface,
      providerMessageId: inbound.messageId,
      actorId: inbound.actorId,
    });
    return disposition;
  }

  private async handleSocketClosed(): Promise<void> {
    await this.ensureLoaded();
    if (!this.state.botToken || !this.state.appToken) return;
    this.state.connected = false;
    this.state.lastError = "Slack Socket Mode connection closed";
    await this.saveState();
    await this.scheduleWake(Date.now() + RETRY_DELAY_MS);
    await this.notifyStatus();
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(code, reason);
    } catch {
      // The persisted lifecycle state remains authoritative.
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<SlackAccountState>(STATE_KEY);
    if (stored) this.state = stored;
    this.loaded = true;
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, this.state);
  }

  private installationContext(): AdapterInstallationContext {
    const identity = resolveAdapterAccountDurableObjectIdentity(this.ctx.id.name, this.state);
    return { installationId: identity.installationId };
  }

  private slackFetch(): SlackFetch {
    return this.env.SLACK_API
      ? (input, init) => this.env.SLACK_API!.fetch(input, init)
      : fetch;
  }

  private async scheduleWake(at: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.getAlarm();
      if (current === null || current > at) await txn.setAlarm(at);
    });
  }

  private async notifyStatus(): Promise<void> {
    try {
      await callAdapterGateway(
        this.env.GATEWAY,
        this.installationContext(),
        "adapter.state.update",
        {
          adapter: "slack",
          accountId: this.state.accountId,
          status: await this.getStatus(),
        },
      );
    } catch {
      // Status polling remains available if the transition notification is lost.
    }
  }
}
