/**
 * Test Adapter Worker
 * 
 * A minimal adapter implementation for end-to-end testing of adapter ↔ Gateway
 * communication. It does not connect to an external service.
 * 
 * Uses a Durable Object to maintain state across requests (important because Gateway
 * calls adapterSend() via Service Binding which may be a different worker invocation).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import {
  cancelBinaryBody,
  readAdapterMediaBody,
  validateAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
} from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import {
  callAdapterGateway,
  type AdapterGatewayBinding,
} from "../../shared/src/gateway-rpc";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import {
  AdapterPeerDeliveryQueue,
  gatewayPeerDeliveryHandlers,
  type AdapterPeerSignalDelivery,
} from "../../shared/src/peer-delivery";
import { renderAdapterPeerSignal } from "../../shared/src/peer-render";
import {
  resolveAdapterActivityRpcArgs,
  resolveAdapterConnectRpcArgs,
  resolveAdapterDisconnectRpcArgs,
  resolveAdapterSendRpcArgs,
  resolveAdapterStatusRpcArgs,
  type AdapterActivityRpcArgs,
  type AdapterConnectRpcArgs,
  type AdapterDisconnectRpcArgs,
  type AdapterSendRpcArgs,
  type AdapterStatusRpcArgs,
} from "../../shared/src/rpc-compat";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterActor,
  AdapterConnectConfig,
  AdapterInboundMessage,
  AdapterInstallationContext,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterPeerSignalFrame,
  AdapterSendResult,
  AdapterService,
  AdapterServiceDescriptor,
  AdapterSurface,
  BinaryBody,
  GatewayFrame,
} from "../../shared/src/types";

type RecordedMessage =
  | {
      direction: "in";
      message: AdapterInboundMessage;
      timestamp: number;
    }
  | {
      direction: "out";
      message: AdapterOutboundMessage;
      timestamp: number;
    };

interface Env {
  GATEWAY: Fetcher & AdapterGatewayBinding;
  TEST_CHANNEL_STATE: DurableObjectNamespace<TestChannelState>;
}

// ============================================================================
// Test Channel State Durable Object
// ============================================================================

export class TestChannelState extends DurableObject<Env> {
  private connected = false;
  private messages: RecordedMessage[] = [];
  private readonly deliveries: DeliveryLedger;
  private readonly peerDeliveries: AdapterPeerDeliveryQueue;
  private peerDrain?: Promise<void>;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.peerDeliveries = new AdapterPeerDeliveryQueue(this.ctx.storage);
    // Load state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.connected = (await this.ctx.storage.get<boolean>("connected")) ?? false;
      this.messages = (await this.ctx.storage.get<RecordedMessage[]>("messages")) ?? [];
    });
  }
  
  async setConnected(connected: boolean): Promise<void> {
    this.connected = connected;
    await this.ctx.storage.put("connected", connected);
  }
  
  async isConnected(): Promise<boolean> {
    return this.connected;
  }
  
  async recordInboundMessage(message: AdapterInboundMessage): Promise<void> {
    this.messages.push({ direction: "in", message, timestamp: Date.now() });
    await this.ctx.storage.put("messages", this.messages);
  }

  async recordOutboundMessage(
    message: AdapterOutboundMessage,
    requestFingerprint: string,
  ): Promise<AdapterSendResult> {
    const claim = await this.deliveries.claim(
      message.deliveryId,
      requestFingerprint,
    );
    if (!claim.claimed) {
      return claim.result;
    }

    if (!this.connected) {
      await this.deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
      return {
        ok: false,
        error: "Test adapter account is not connected",
        retryable: true,
      };
    }

    const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { direction: "out", message, timestamp: Date.now() } as const;
    this.messages.push(record);
    try {
      await this.ctx.storage.put("messages", this.messages);
    } catch (error) {
      this.messages.pop();
      const detail = error instanceof Error ? error.message : String(error);
      await this.deliveries.failAmbiguous(
        message.deliveryId,
        claim.attemptId,
        `Test adapter record outcome is unknown: ${detail}`,
      );
      return {
        ok: false,
        error: `Test adapter record outcome is unknown: ${detail}`,
        ambiguous: true,
      };
    }

    try {
      await this.deliveries.succeed(message.deliveryId, claim.attemptId, messageId);
    } catch {
      return {
        ok: false,
        error: "Test adapter recorded the delivery but could not persist its outcome",
        ambiguous: true,
      };
    }
    return { ok: true, messageId };
  }
  
  async getMessages(): Promise<RecordedMessage[]> {
    return this.messages;
  }
  
  async getOutboundMessages(): Promise<AdapterOutboundMessage[]> {
    return this.messages
      .filter(m => m.direction === "out")
      .map(m => m.message);
  }
  
  async clearMessages(): Promise<void> {
    this.messages = [];
    await this.ctx.storage.put("messages", []);
  }
  
  async reset(): Promise<void> {
    this.connected = false;
    this.messages = [];
    await this.ctx.storage.deleteAll();
  }

  async acceptPeerSignal(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: AdapterPeerSignalFrame,
    body?: BinaryBody,
  ): Promise<void> {
    await this.peerDeliveries.enqueueAndArm(
      { installation, context, frame },
      body,
      Date.now() + 10,
    );
    this.ctx.waitUntil(this.drainPeerDeliveries());
  }

  async alarm(): Promise<void> {
    await this.drainPeerDeliveries();
    await this.peerDeliveries.armIfPending(Date.now() + 10_000);
  }

  private async drainPeerDeliveries(): Promise<void> {
    if (this.peerDrain) return await this.peerDrain;
    const running = (async () => {
      for (const deliveryId of await this.peerDeliveries.pendingIds()) {
        const result = await this.peerDeliveries.attempt(
          deliveryId,
          gatewayPeerDeliveryHandlers({
            adapter: "test",
            gateway: this.env.GATEWAY,
            deliver: async (delivery, body) => await this.deliverPeerSignal(delivery, body),
          }),
        );
        if (result === "pending") break;
      }
    })();
    this.peerDrain = running;
    try {
      await running;
    } finally {
      if (this.peerDrain === running) this.peerDrain = undefined;
    }
  }

  private async deliverPeerSignal(
    delivery: AdapterPeerSignalDelivery,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    const rendered = renderAdapterPeerSignal(delivery.context, delivery.frame).message;
    const mediaBytes = await readAdapterMediaBody(rendered.media, body, {
      maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
      maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
    });
    const fingerprint = await fingerprintOutboundDelivery(rendered, mediaBytes);
    const outbound: AdapterOutboundMessage = {
      ...rendered,
      media: rendered.media?.map((item, index) => {
        const { body: _body, ...metadata } = item;
        return { ...metadata, size: metadata.size ?? mediaBytes[index]?.byteLength };
      }),
    };
    return await this.recordOutboundMessage(outbound, fingerprint);
  }
}

// ============================================================================
// Test Channel WorkerEntrypoint
// ============================================================================

export class TestChannel extends WorkerEntrypoint<Env> implements AdapterService {
  readonly adapterId = "test";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "Test",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: true,
        pairing: false,
        deliveryFrames: true,
        surfaces: ["dm", "group", "channel", "thread"],
        media: {
          inbound: ["image", "audio", "video", "document"],
          outbound: ["image", "audio", "video", "document"],
        },
      },
    };
  }

  async adapterFrame(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: GatewayFrame,
    body?: BinaryBody,
  ): Promise<GatewayFrame | null> {
    const parsed = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsed, context.accountId);
    return await handleAdapterFrame(this.adapterId, parsed, context, frame, body, {
      send: async (message, requestBody) => await this.#adapterSendForInstallation(
        parsed,
        context.accountId,
        message,
        requestBody,
      ),
      acceptSignal: async (signalContext, signalFrame, signalBody) => {
        await state.acceptPeerSignal(parsed, signalContext, signalFrame, signalBody);
      },
    });
  }

  private getStateDO(
    installation: AdapterInstallationContext,
    accountId: string,
  ): DurableObjectStub<TestChannelState> {
    const id = this.env.TEST_CHANNEL_STATE.idFromName(
      adapterAccountDurableObjectName(installation, accountId),
    );
    return this.env.TEST_CHANNEL_STATE.get(id);
  }

  async adapterConnect(
    accountId: string,
    config?: AdapterConnectConfig,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }>;
  async adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config?: AdapterConnectConfig,
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }>;
  async adapterConnect(
    ...args: AdapterConnectRpcArgs
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    const resolved = resolveAdapterConnectRpcArgs(args);
    return await this.#adapterConnectForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.config,
    );
  }

  async #adapterConnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    _config: AdapterConnectConfig = {},
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    await state.setConnected(true);
    return {
      ok: true,
      connected: true,
      authenticated: true,
      message: "Connected",
    };
  }

  async adapterDisconnect(
    accountId: string,
  ): Promise<{ ok: true; message: string }>;
  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<{ ok: true; message: string }>;
  async adapterDisconnect(
    ...args: AdapterDisconnectRpcArgs
  ): Promise<{ ok: true; message: string }> {
    const resolved = resolveAdapterDisconnectRpcArgs(args);
    return await this.#adapterDisconnectForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterDisconnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<{ ok: true; message: string }> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    await state.setConnected(false);
    return { ok: true, message: "Disconnected" };
  }

  async adapterStatus(
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(...args: AdapterStatusRpcArgs): Promise<AdapterAccountStatus[]> {
    const resolved = resolveAdapterStatusRpcArgs(args);
    return await this.#adapterStatusForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterStatusForInstallation(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (accountId) {
      const state = this.getStateDO(parsedInstallation, accountId);
      const connected = await state.isConnected();
      return [{
        accountId,
        connected,
        authenticated: connected,
        mode: "test",
      }];
    }
    // Can't list all accounts without a DO per-account tracking
    return [];
  }

  /**
   * Send a message (Gateway → Channel).
   * Records it in the account's Durable Object.
   */
  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  async adapterSend(...args: AdapterSendRpcArgs): Promise<AdapterSendResult> {
    const resolved = await resolveAdapterSendRpcArgs(args);
    return await this.#adapterSendForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.message,
      resolved.body,
    );
  }

  async #adapterSendForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    let parsedInstallation: AdapterInstallationContext;
    try {
      parsedInstallation = parseAdapterInstallationContext(installation);
    } catch (error) {
      await cancelBinaryBody(body, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      validateAdapterMediaBody(message.media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(message.media, body, {
        maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
        maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    const state = this.getStateDO(parsedInstallation, accountId);
    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintOutboundDelivery(message, mediaBytes);
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint test adapter delivery: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: true,
      };
    }
    const outbound: AdapterOutboundMessage = {
      deliveryId: message.deliveryId,
      surface: message.surface,
      actorId: message.actorId,
      text: message.text,
      replyToId: message.replyToId,
      media: message.media?.map((item, index) => {
        const { body: _body, ...metadata } = item;
        return {
          ...metadata,
          size: metadata.size ?? mediaBytes[index]?.byteLength,
        };
      }),
    };
    try {
      const result = await state.recordOutboundMessage(outbound, requestFingerprint);
      if (result.ok && !result.deduplicated) {
        console.log(
          `[TestChannel] Sent to ${accountId}/${message.surface.id}: ${message.text.slice(0, 50)}...`,
        );
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        error: `Test adapter delivery outcome is unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ambiguous: true,
      };
    }
  }

  async adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  async adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  async adapterSetActivity(
    ...args: AdapterActivityRpcArgs
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = resolveAdapterActivityRpcArgs(args);
    return await this.#adapterSetActivityForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.surface,
      resolved.activity,
    );
  }

  async #adapterSetActivityForInstallation(
    installation: AdapterInstallationContext,
    _accountId: string,
    _surface: AdapterSurface,
    _activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    parseAdapterInstallationContext(installation);
    return { ok: true };
  }

  // =========================================================================
  // Test-only methods
  // =========================================================================

  async simulateInbound(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    text: string,
    options?: {
      actor?: AdapterActor;
      media?: AdapterMedia[];
      body?: BinaryBody;
      replyToId?: string;
      replyToText?: string;
      wasMentioned?: boolean;
    },
  ): Promise<{ ok: boolean; messageId: string; error?: string }> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    const connected = await state.isConnected();
    if (!connected) {
      await cancelBinaryBody(options?.body, "Test adapter account is not connected");
      return { ok: false, messageId: "", error: "Account not connected" };
    }

    const messageId = `test-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const message: AdapterInboundMessage = {
      messageId,
      surface,
      actor: options?.actor ?? { id: `test:user:${surface.id}` },
      text,
      media: options?.media,
      replyToId: options?.replyToId,
      replyToText: options?.replyToText,
      timestamp: Date.now(),
      wasMentioned: surface.kind === "dm" ? true : options?.wasMentioned === true,
    };

    await state.recordInboundMessage(message);

    console.log(`[TestChannel] Simulating inbound from ${surface.id}: ${text}`);

    try {
      const result = await callAdapterGateway(
        this.env.GATEWAY,
        parsedInstallation,
        "adapter.inbound",
        { adapter: "test", accountId, deliveryId: messageId, message },
        options?.body,
      );
      if (!result.ok) {
        return { ok: false, messageId, error: result.error || "Gateway rejected message" };
      }
      return { ok: true, messageId };
    } catch (e) {
      await cancelBinaryBody(options?.body, e);
      console.error(`[TestChannel] RPC send failed:`, e);
      return { ok: false, messageId, error: String(e) };
    }
  }

  async getMessages(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<RecordedMessage[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    return await state.getMessages();
  }

  async getOutboundMessages(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterOutboundMessage[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    return await state.getOutboundMessages();
  }

  async clearMessages(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<void> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    await state.clearMessages();
  }

  async reset(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<void> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    const state = this.getStateDO(parsedInstallation, accountId);
    await state.reset();
  }
}

// ============================================================================
// HTTP Handler
// ============================================================================

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-test",
        status: "ok",
      });
    }

    // Test adapter controls are only available through the service-binding RPC entrypoint.
    if (url.pathname.startsWith("/test/")) {
      return new Response("Not Found", { status: 404 });
    }
    
    return new Response("Not Found", { status: 404 });
  },
};
