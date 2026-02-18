/**
 * Test Channel Worker
 * 
 * A minimal channel implementation for e2e testing the Channel ↔ Gateway communication.
 * This channel doesn't connect to any external service - it's purely for testing
 * the Gateway channel architecture.
 * 
 * Uses a Durable Object to maintain state across requests (important because Gateway
 * calls send() via Service Binding which may be a different worker invocation).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// ============================================================================
// Types
// ============================================================================

type ChannelPeer = {
  kind: "dm" | "group" | "channel" | "thread";
  id: string;
  name?: string;
};

type ChannelSender = {
  id: string;
  name?: string;
};

type ChannelMedia = {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  data?: string;
  url?: string;
};

type ChannelInboundMessage = {
  messageId: string;
  peer: ChannelPeer;
  sender?: ChannelSender;
  text: string;
  media?: ChannelMedia[];
  timestamp?: number;
  replyToId?: string;
  replyToText?: string;
  wasMentioned?: boolean;
};

type ChannelOutboundMessage = {
  peer: ChannelPeer;
  text: string;
  replyToId?: string;
};

type ChannelAccountStatus = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  error?: string;
};

type ChannelCapabilities = {
  chatTypes: Array<"dm" | "group" | "channel" | "thread">;
  media: boolean;
  reactions: boolean;
  threads: boolean;
  typing: boolean;
  editing: boolean;
  deletion: boolean;
};

type StartResult = { ok: true } | { ok: false; error: string };
type StopResult = { ok: true } | { ok: false; error: string };
type SendResult = { ok: true; messageId?: string } | { ok: false; error: string };

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

type RecordedMessage = { direction: "in" | "out"; message: ChannelOutboundMessage | ChannelInboundMessage; timestamp: number };

interface Env {
  GATEWAY: GatewayChannelBinding;
  TEST_CHANNEL_STATE: DurableObjectNamespace;
}

// ============================================================================
// Test Channel State Durable Object
// ============================================================================

export class TestChannelState extends DurableObject<Env> {
  private connected = false;
  private messages: RecordedMessage[] = [];
  
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Load state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.connected = (await this.ctx.storage.get<boolean>("connected")) ?? false;
      this.messages = (await this.ctx.storage.get<RecordedMessage[]>("messages")) ?? [];
    });
  }
  
  async start(): Promise<void> {
    this.connected = true;
    await this.ctx.storage.put("connected", true);
  }
  
  async stop(): Promise<void> {
    this.connected = false;
    await this.ctx.storage.put("connected", false);
  }
  
  async isConnected(): Promise<boolean> {
    return this.connected;
  }
  
  async recordMessage(direction: "in" | "out", message: ChannelOutboundMessage | ChannelInboundMessage): Promise<void> {
    this.messages.push({ direction, message, timestamp: Date.now() });
    await this.ctx.storage.put("messages", this.messages);
  }
  
  async getMessages(): Promise<RecordedMessage[]> {
    return this.messages;
  }
  
  async getOutboundMessages(): Promise<ChannelOutboundMessage[]> {
    return this.messages
      .filter(m => m.direction === "out")
      .map(m => m.message as ChannelOutboundMessage);
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

export class TestChannel extends WorkerEntrypoint<Env> {
  readonly channelId = "test";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
  };

  private getStateDO(accountId: string): DurableObjectStub<TestChannelState> {
    const id = this.env.TEST_CHANNEL_STATE.idFromName(accountId);
    return this.env.TEST_CHANNEL_STATE.get(id) as DurableObjectStub<TestChannelState>;
  }

  async start(accountId: string, _config: Record<string, unknown>): Promise<StartResult> {
    const state = this.getStateDO(accountId);
    await state.start();
    
    await this.env.GATEWAY.channelStatusChanged("test", accountId, {
      accountId,
      connected: true,
      authenticated: true,
      mode: "test",
    });
    
    return { ok: true };
  }

  async stop(accountId: string): Promise<StopResult> {
    const state = this.getStateDO(accountId);
    await state.stop();
    
    await this.env.GATEWAY.channelStatusChanged("test", accountId, {
      accountId,
      connected: false,
      authenticated: false,
    });
    
    return { ok: true };
  }

  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
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
  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
    const state = this.getStateDO(accountId);
    await state.recordMessage("out", message);
    
    const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[TestChannel] Sent to ${accountId}/${message.peer.id}: ${message.text.slice(0, 50)}...`);
    
    return { ok: true, messageId };
  }

  async setTyping(_accountId: string, _peer: ChannelPeer, _typing: boolean): Promise<void> {
    // No-op
  }

  // =========================================================================
  // Test-only methods
  // =========================================================================

  async simulateInbound(
    accountId: string,
    peer: ChannelPeer,
    text: string,
    options?: { sender?: ChannelSender; media?: ChannelMedia[]; replyToId?: string; replyToText?: string }
  ): Promise<{ ok: boolean; messageId: string; error?: string }> {
    const state = this.getStateDO(accountId);
    const connected = await state.isConnected();
    if (!connected) {
      return { ok: false, messageId: "", error: "Account not connected" };
    }

    const messageId = `test-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const message: ChannelInboundMessage = {
      messageId,
      peer,
      sender: options?.sender,
      text,
      media: options?.media,
      replyToId: options?.replyToId,
      replyToText: options?.replyToText,
      timestamp: Date.now(),
    };

    await state.recordMessage("in", message);

    console.log(`[TestChannel] Simulating inbound from ${peer.id}: ${text}`);

    try {
      const result = await this.env.GATEWAY.channelInbound("test", accountId, message);
      if (!result.ok) {
        return { ok: false, messageId, error: result.error || "Gateway rejected message" };
      }
      return { ok: true, messageId };
    } catch (e) {
      console.error(`[TestChannel] RPC send failed:`, e);
      return { ok: false, messageId, error: String(e) };
    }
  }

  async getMessages(accountId: string): Promise<RecordedMessage[]> {
    const state = this.getStateDO(accountId);
    return await state.getMessages();
  }

  async getOutboundMessages(accountId: string): Promise<ChannelOutboundMessage[]> {
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

    // Helper to get DO stub
    const getState = (accountId: string) => {
      const id = env.TEST_CHANNEL_STATE.idFromName(accountId);
      return env.TEST_CHANNEL_STATE.get(id) as DurableObjectStub<TestChannelState>;
    };

    // POST /test/start?accountId=xxx
    if (url.pathname === "/test/start" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId") || "default";
      const state = getState(accountId);
      await state.start();
      
      await env.GATEWAY.channelStatusChanged("test", accountId, {
        accountId,
        connected: true,
        authenticated: true,
        mode: "test",
      });
      
      return Response.json({ ok: true, accountId });
    }

    // POST /test/stop?accountId=xxx
    if (url.pathname === "/test/stop" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId") || "default";
      const state = getState(accountId);
      await state.stop();
      
      await env.GATEWAY.channelStatusChanged("test", accountId, {
        accountId,
        connected: false,
        authenticated: false,
      });
      
      return Response.json({ ok: true, accountId });
    }

    // POST /test/inbound
    if (url.pathname === "/test/inbound" && request.method === "POST") {
      const body = await request.json() as {
        accountId: string;
        peer: ChannelPeer;
        text: string;
        sender?: ChannelSender;
        media?: ChannelMedia[];
      };
      
      const state = getState(body.accountId);
      const connected = await state.isConnected();
      if (!connected) {
        return Response.json({ ok: false, error: "Account not connected" }, { status: 400 });
      }

      const messageId = `test-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      
      const message: ChannelInboundMessage = {
        messageId,
        peer: body.peer,
        sender: body.sender,
        text: body.text,
        media: body.media,
        timestamp: Date.now(),
      };

      await state.recordMessage("in", message);

      const result = await env.GATEWAY.channelInbound("test", body.accountId, message);
      if (!result.ok) {
        return Response.json(
          { ok: false, error: result.error || "Gateway rejected message", messageId },
          { status: 500 },
        );
      }

      return Response.json({ ok: true, messageId });
    }

    // GET /test/messages?accountId=xxx
    if (url.pathname === "/test/messages" && request.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "default";
      const state = getState(accountId);
      const messages = await state.getMessages();
      return Response.json({ accountId, messages });
    }

    // GET /test/outbound?accountId=xxx
    if (url.pathname === "/test/outbound" && request.method === "GET") {
      const accountId = url.searchParams.get("accountId") || "default";
      const state = getState(accountId);
      const messages = await state.getOutboundMessages();
      return Response.json({ accountId, messages });
    }

    // POST /test/clear?accountId=xxx
    if (url.pathname === "/test/clear" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId") || "default";
      const state = getState(accountId);
      await state.clearMessages();
      return Response.json({ ok: true, accountId });
    }

    // POST /test/reset?accountId=xxx
    if (url.pathname === "/test/reset" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId");
      if (accountId) {
        const state = getState(accountId);
        await state.reset();
      }
      return Response.json({ ok: true });
    }
    
    return new Response("Not Found", { status: 404 });
  },
};
