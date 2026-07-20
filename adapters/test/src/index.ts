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
import {
  isHelpCommand,
  parseAttachArgs,
  parseShellWords,
} from "../../shared/src/command";
import type {
  ChannelAccountStatus,
  ChannelCapabilities,
  ChannelInboundMessage,
  ChannelMedia,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelSender,
  GatewayFrame,
  GatewayRequestFrame,
  SendResult,
  ShellExecArgs,
  ShellExecResult,
  StartResult,
  StopResult,
} from "../../shared/src/types";

type GatewayChannelBinding = Fetcher & {
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
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
  readonly adapterId = "test";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: true,
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
    
    await this.callGateway("adapter.state.update", {
      adapter: "test",
      accountId,
      status: {
        accountId,
        connected: true,
        authenticated: true,
        mode: "test",
      },
    });
    
    return { ok: true };
  }

  async stop(accountId: string): Promise<StopResult> {
    const state = this.getStateDO(accountId);
    await state.stop();
    
    await this.callGateway("adapter.state.update", {
      adapter: "test",
      accountId,
      status: {
        accountId,
        connected: false,
        authenticated: false,
      },
    });
    
    return { ok: true };
  }

  async adapterStatus(accountId?: string): Promise<ChannelAccountStatus[]> {
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

  async status(accountId?: string) {
    return this.adapterStatus(accountId);
  }

  /**
   * Send a message (Gateway → Channel).
   * Records it in the account's Durable Object.
   */
  async adapterSend(
    accountId: string,
    message: {
      surface: ChannelPeer;
      text: string;
      replyToId?: string;
      media?: ChannelMedia[];
    },
  ): Promise<SendResult> {
    const state = this.getStateDO(accountId);
    const outbound: ChannelOutboundMessage = {
      peer: message.surface,
      text: message.text,
      replyToId: message.replyToId,
      media: message.media,
    };
    await state.recordMessage("out", outbound);
    
    const messageId = `test-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[TestChannel] Sent to ${accountId}/${message.surface.id}: ${message.text.slice(0, 50)}...`);
    
    return { ok: true, messageId };
  }

  async send(accountId: string, message: ChannelOutboundMessage) {
    return this.adapterSend(accountId, {
      surface: message.peer,
      text: message.text,
      replyToId: message.replyToId,
      media: message.media,
    });
  }

  async adapterSetActivity(
    _accountId: string,
    _surface: ChannelPeer,
    _activity: { kind: "typing" | "recording" | "uploading"; active: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: true };
  }

  async setTyping(_accountId: string, _peer: ChannelPeer, _typing: boolean): Promise<void> {
    // No-op
  }

  async adapterShellExec(accountId: string, args: ShellExecArgs): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";
    if (isHelpCommand(command)) {
      return shellOk([
        "test adapter commands:",
        "  help | -h | --help",
        "  send <surface-id> <text>",
        "  reply <surface-id> <message-id> <text>",
        "  react <surface-id> <message-id> <emoji>",
        "  attach <surface-id> <url> [--filename <name>] [caption]",
      ].join("\n"));
    }

    if (command === "send") {
      const [surfaceId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!surfaceId || !text) {
        return shellFail("usage: send <surface-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: { kind: "dm", id: surfaceId },
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      const [surfaceId, messageId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!surfaceId || !messageId || !text) {
        return shellFail("usage: reply <surface-id> <message-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: { kind: "dm", id: surfaceId },
        text,
        replyToId: messageId,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "react") {
      const [surfaceId, messageId, emoji] = tokens.slice(1);
      if (!surfaceId || !messageId || !emoji) {
        return shellFail("usage: react <surface-id> <message-id> <emoji>");
      }
      return shellOk(`reacted ${emoji} to ${surfaceId}/${messageId}`);
    }

    if (command === "attach") {
      const { targetId: surfaceId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!surfaceId || !url) {
        return shellFail("usage: attach <surface-id> <url> [--filename <name>] [caption]");
      }
      const result = await this.adapterSend(accountId, {
        surface: { kind: "dm", id: surfaceId },
        text: caption,
        media: [await mediaFromUrl(url, filename)],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    return shellFail(`unknown command: ${command}`);
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
      const result = await this.callGateway<{ ok: boolean; error?: string }>(
        "adapter.inbound",
        {
          adapter: "test",
          accountId,
          message: {
            ...message,
            surface: message.peer,
            actor: message.sender,
            peer: undefined,
            sender: undefined,
          },
        },
      );
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
      throw new Error(response.error?.message ?? `Gateway error on ${call}`);
    }
    return (response.data ?? {}) as T;
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

    // Test adapter controls are only available through the service-binding RPC entrypoint.
    if (url.pathname.startsWith("/test/")) {
      return new Response("Not Found", { status: 404 });
    }
    
    return new Response("Not Found", { status: 404 });
  },
};

async function mediaFromUrl(url: string, filename?: string): Promise<ChannelMedia> {
  let mimeType = "application/octet-stream";
  try {
    const response = await fetch(url, { method: "HEAD" });
    mimeType = response.headers.get("Content-Type")?.split(";")[0].trim() || mimeType;
  } catch {
    // Test adapter does not need to fetch the body; fall back to generic binary.
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
