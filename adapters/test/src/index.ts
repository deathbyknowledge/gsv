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
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterActor,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
  GatewayFrame,
  GatewayRequestFrame,
} from "../../shared/src/types";

type GatewayAdapterBinding = Fetcher & {
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
};

type RecordedMessage = {
  direction: "in" | "out";
  message: AdapterOutboundMessage | AdapterInboundMessage;
  timestamp: number;
};

interface Env {
  GATEWAY: GatewayAdapterBinding;
  TEST_CHANNEL_STATE: DurableObjectNamespace;
}

// ============================================================================
// Test Channel State Durable Object
// ============================================================================

export class TestChannelState extends DurableObject<Env> {
  private connected = false;
  private messages: RecordedMessage[] = [];
  private readonly deliveries: DeliveryLedger;
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
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
  
  async recordMessage(
    direction: "in" | "out",
    message: AdapterOutboundMessage | AdapterInboundMessage,
  ): Promise<void> {
    this.messages.push({ direction, message, timestamp: Date.now() });
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
    } catch (error) {
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
      .map(m => m.message as AdapterOutboundMessage);
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
}

// ============================================================================
// Test Channel WorkerEntrypoint
// ============================================================================

export class TestChannel extends WorkerEntrypoint<Env> implements AdapterWorkerInterface {
  readonly adapterId = "test";

  private getStateDO(accountId: string): DurableObjectStub<TestChannelState> {
    const id = this.env.TEST_CHANNEL_STATE.idFromName(accountId);
    return this.env.TEST_CHANNEL_STATE.get(id) as DurableObjectStub<TestChannelState>;
  }

  async adapterConnect(
    accountId: string,
    _config: Record<string, unknown> = {},
  ): Promise<{ ok: true; connected: true; authenticated: true; message: string }> {
    const state = this.getStateDO(accountId);
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
  ): Promise<{ ok: true; message: string }> {
    const state = this.getStateDO(accountId);
    await state.setConnected(false);
    return { ok: true, message: "Disconnected" };
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
    if (accountId) {
      const state = this.getStateDO(accountId);
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
  ): Promise<AdapterSendResult> {
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
    const state = this.getStateDO(accountId);
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
    _accountId: string,
    _surface: AdapterSurface,
    _activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: true };
  }

  // =========================================================================
  // Test-only methods
  // =========================================================================

  async simulateInbound(
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
    const state = this.getStateDO(accountId);
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

    await state.recordMessage("in", message);

    console.log(`[TestChannel] Simulating inbound from ${surface.id}: ${text}`);

    try {
      const frame: GatewayRequestFrame = {
        type: "req",
        id: crypto.randomUUID(),
        call: "adapter.inbound",
        args: { adapter: "test", accountId, message },
        ...(options?.body ? { body: options.body } : {}),
      };
      const response = await this.env.GATEWAY.serviceFrame(frame);
      if (!response || response.type !== "res") {
        return { ok: false, messageId, error: "No response from gateway serviceFrame" };
      }
      if (!response.ok) {
        return {
          ok: false,
          messageId,
          error: response.error?.message || "Gateway rejected message",
        };
      }
      const result = (response.data ?? {}) as AdapterInboundResult;
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

  async getMessages(accountId: string): Promise<RecordedMessage[]> {
    const state = this.getStateDO(accountId);
    return await state.getMessages();
  }

  async getOutboundMessages(accountId: string): Promise<AdapterOutboundMessage[]> {
    const state = this.getStateDO(accountId);
    return await state.getOutboundMessages();
  }

  async clearMessages(accountId: string): Promise<void> {
    const state = this.getStateDO(accountId);
    await state.clearMessages();
  }

  async reset(accountId: string): Promise<void> {
    const state = this.getStateDO(accountId);
    await state.reset();
  }
}

// ============================================================================
// HTTP Handler
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
