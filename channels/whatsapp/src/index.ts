/**
 * GSV WhatsApp Channel Worker
 * 
 * This worker manages WhatsApp accounts as channel connections to GSV Gateway.
 * Each WhatsApp account is a separate Durable Object instance.
 */

// Polyfill for Node.js timer methods not available in Workers
// Baileys uses setInterval(...).unref() which doesn't exist in workerd
// In workerd, timers return numbers, but Node.js returns objects with unref/ref methods

// Wrap timer IDs in objects with unref/ref methods
class TimerRef {
  constructor(public id: number) {}
  unref() { return this; }
  ref() { return this; }
  [Symbol.toPrimitive]() { return this.id; }
}

// Store originals before patching
const _setInterval = globalThis.setInterval;
const _setTimeout = globalThis.setTimeout;
const _clearInterval = globalThis.clearInterval;
const _clearTimeout = globalThis.clearTimeout;

(globalThis as any).setInterval = function(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const id = _setInterval(callback as any, ms, ...args);
  return new TimerRef(id as unknown as number);
};

(globalThis as any).setTimeout = function(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const id = _setTimeout(callback as any, ms, ...args);
  return new TimerRef(id as unknown as number);
};

(globalThis as any).clearInterval = function(id: unknown) {
  const actualId = id instanceof TimerRef ? id.id : id;
  return _clearInterval(actualId as any);
};

(globalThis as any).clearTimeout = function(id: unknown) {
  const actualId = id instanceof TimerRef ? id.id : id;
  return _clearTimeout(actualId as any);
};

// The 'ws' package used by Baileys isn't compatible with Workers.
// We need to patch Baileys to use native WebSocket instead.
// This is done via wrangler.jsonc alias configuration.

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ChannelWorkerInterface,
  ChannelCapabilities,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelAccountStatus,
  StartResult,
  StopResult,
  SendResult,
  LoginResult,
  LogoutResult,
} from "./channel-types";

export { WhatsAppAccount } from "./whatsapp-account";

interface Env {
  WHATSAPP_ACCOUNT: DurableObjectNamespace;
}

/**
 * WhatsApp Channel Entrypoint for Service Binding RPC
 * 
 * Gateway calls these methods via Service Bindings to send outbound messages.
 */
export class WhatsAppChannelEntrypoint extends WorkerEntrypoint<Env> implements ChannelWorkerInterface {
  readonly channelId = "whatsapp";
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
    qrLogin: true,
  };

  async start(accountId: string, _config: Record<string, unknown>): Promise<StartResult> {
    try {
      const res = await this.doFetch(accountId, "/wake", { method: "POST" });
      const data = await res.json() as { success?: boolean; error?: string };
      return data.success ? { ok: true } : { ok: false, error: data.error || "Failed to start" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async stop(accountId: string): Promise<StopResult> {
    try {
      const res = await this.doFetch(accountId, "/stop", { method: "POST" });
      const data = await res.json() as { success?: boolean; error?: string };
      return data.success ? { ok: true } : { ok: false, error: data.error || "Failed to stop" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (!accountId) {
      // TODO: List all accounts
      return [];
    }
    try {
      const res = await this.doFetch(accountId, "/status");
      const data = await res.json() as any;
      return [{
        accountId,
        connected: data.connected || false,
        authenticated: !!data.selfJid,
        mode: "websocket",
        lastActivity: data.lastMessageAt,
        extra: { selfJid: data.selfJid, selfE164: data.selfE164 },
      }];
    } catch (e) {
      return [{
        accountId: accountId || "unknown",
        connected: false,
        authenticated: false,
        error: String(e),
      }];
    }
  }

  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
    try {
      console.log(`[WhatsAppEntrypoint] send() called for ${accountId} to ${message.peer.id}`);
      const res = await this.doFetch(accountId, "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      const data = await res.json() as { success?: boolean; messageId?: string; error?: string };
      if (data.success) {
        return { ok: true, messageId: data.messageId };
      }
      return { ok: false, error: data.error || "Failed to send" };
    } catch (e) {
      console.error(`[WhatsAppEntrypoint] send() error:`, e);
      return { ok: false, error: String(e) };
    }
  }

  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    try {
      await this.doFetch(accountId, "/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer, typing }),
      });
    } catch (e) {
      console.error(`[WhatsAppEntrypoint] setTyping() error:`, e);
    }
  }

  async login(accountId: string, options?: { force?: boolean }): Promise<LoginResult> {
    try {
      const path = options?.force ? "/login?force=true" : "/login";
      const res = await this.doFetch(accountId, path, { method: "POST" });
      const data = await res.json() as { connected?: boolean; qr?: string; message?: string; error?: string };
      if (data.connected) {
        return { ok: true, message: data.message || "Connected" };
      }
      if (data.qr) {
        return { ok: true, qrDataUrl: data.qr, message: data.message || "Scan QR code" };
      }
      return { ok: false, error: data.error || "Login failed" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async logout(accountId: string): Promise<LogoutResult> {
    try {
      const res = await this.doFetch(accountId, "/logout", { method: "POST" });
      const data = await res.json() as { success?: boolean; error?: string };
      return data.success ? { ok: true } : { ok: false, error: data.error || "Failed to logout" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private getDO(accountId: string) {
    const id = this.env.WHATSAPP_ACCOUNT.idFromName(accountId);
    return this.env.WHATSAPP_ACCOUNT.get(id);
  }

  private doFetch(accountId: string, path: string, init?: RequestInit): Promise<Response> {
    const stub = this.getDO(accountId);
    const headers = new Headers(init?.headers);
    headers.set("X-Account-Id", accountId);
    return stub.fetch(new Request(`http://do${path}`, { ...init, headers }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route: /account/:accountId/...
    const accountMatch = path.match(/^\/account\/([^\/]+)(\/.*)?$/);
    if (accountMatch) {
      const accountId = accountMatch[1];
      const subPath = accountMatch[2] || "/status";
      
      // Get or create the DO for this account
      const id = env.WHATSAPP_ACCOUNT.idFromName(accountId);
      const stub = env.WHATSAPP_ACCOUNT.get(id);
      
      // Forward request to DO with adjusted path and X-Account-Id header
      const doUrl = new URL(request.url);
      doUrl.pathname = subPath;
      const headers = new Headers(request.headers);
      headers.set("X-Account-Id", accountId);
      
      return stub.fetch(new Request(doUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    // List accounts (would need separate tracking)
    if (path === "/accounts") {
      return Response.json({
        message: "Account listing not yet implemented. Use /account/:accountId/status to check a specific account.",
      });
    }

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json({
        service: "gsv-channel-whatsapp",
        status: "ok",
        usage: {
          login: "POST /account/:accountId/login",
          logout: "POST /account/:accountId/logout",
          start: "POST /account/:accountId/start",
          stop: "POST /account/:accountId/stop",
          wake: "POST /account/:accountId/wake",
          status: "GET /account/:accountId/status",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
