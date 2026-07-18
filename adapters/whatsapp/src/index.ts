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
import { cancelBinaryBody } from "../../shared/src/media-body";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
} from "../../shared/src/types";

export { WhatsAppAccount } from "./whatsapp-account";

interface Env {
  WHATSAPP_ACCOUNT: DurableObjectNamespace;
}

type WhatsAppAccountStub = DurableObjectStub & {
  sendMessage(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
};

type LoginAttemptResult =
  | { ok: true; qrDataUrl?: string; message: string }
  | { ok: false; error: string };

/**
 * WhatsApp Channel Entrypoint for Service Binding RPC
 * 
 * Gateway calls these methods via Service Bindings to send outbound messages.
 */
export class WhatsAppChannelEntrypoint
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "whatsapp";

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks the RPC call before it
  // reaches this worker entrypoint.
  async adapterConnect(
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    const force = config.force === true || config.force === "true";
    const traceId =
      typeof config.__traceId === "string" && config.__traceId.trim().length > 0
        ? config.__traceId.trim()
        : "no-trace";
    console.log(
      `[whatsapp.connect:${traceId}] start accountId=${accountId} force=${force ? "true" : "false"}`,
    );
    const login = await this.requestLogin(accountId, { force, traceId });
    console.log(
      `[whatsapp.connect:${traceId}] login ok=${login.ok === true} qr=${Boolean(login.ok && "qrDataUrl" in login && login.qrDataUrl)}`,
    );
    if (!login.ok) {
      return { ok: false, error: login.error };
    }

    if (login.qrDataUrl) {
      return {
        ok: true,
        connected: true,
        authenticated: false,
        message: login.message,
        challenge: {
          type: "qr",
          message: login.message,
          data: login.qrDataUrl,
        },
      };
    }

    return {
      ok: true,
      connected: true,
      authenticated: true,
      message: login.message,
    };
  }

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult> {
    const logout = await this.requestLogout(accountId);
    if (!logout.ok) {
      return { ok: false, error: logout.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
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

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      console.log(`[WhatsAppEntrypoint] send() called for ${accountId} to ${message.surface.id}`);
      return await this.getDO(accountId).sendMessage(accountId, message, body);
    } catch (e) {
      await cancelBinaryBody(body, e);
      console.error(`[WhatsAppEntrypoint] send() error:`, e);
      return { ok: false, error: String(e), retryable: true };
    }
  }

  async adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      const response = await this.doFetch(accountId, "/typing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer: surface, typing: activity.active }),
      });
      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !data.success) {
        return { ok: false, error: data.error || "Failed to set WhatsApp activity" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async requestLogin(
    accountId: string,
    options?: { force?: boolean; traceId?: string },
  ): Promise<LoginAttemptResult> {
    try {
      const traceId = options?.traceId?.trim() || "no-trace";
      const path = options?.force ? "/login?force=true" : "/login";
      console.log(`[whatsapp.login:${traceId}] forwarding accountId=${accountId} path=${path}`);
      const res = await this.doFetch(accountId, path, { method: "POST" }, traceId);
      const data = await res.json() as { connected?: boolean; qr?: string; message?: string; error?: string };
      console.log(
        `[whatsapp.login:${traceId}] response status=${res.status} connected=${Boolean(data.connected)} qr=${Boolean(data.qr)} error=${data.error ?? ""}`,
      );
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

  private async requestLogout(
    accountId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await this.doFetch(accountId, "/logout", { method: "POST" });
      const data = await res.json() as { success?: boolean; error?: string };
      return data.success ? { ok: true } : { ok: false, error: data.error || "Failed to logout" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private getDO(accountId: string): WhatsAppAccountStub {
    const id = this.env.WHATSAPP_ACCOUNT.idFromName(accountId);
    return this.env.WHATSAPP_ACCOUNT.get(id) as WhatsAppAccountStub;
  }

  private doFetch(
    accountId: string,
    path: string,
    init?: RequestInit,
    traceId?: string,
  ): Promise<Response> {
    const stub = this.getDO(accountId);
    const headers = new Headers(init?.headers);
    headers.set("X-Account-Id", accountId);
    if (traceId) {
      headers.set("X-Trace-Id", traceId);
    }
    const url = new URL(path, "https://whatsapp-account.internal");
    console.log(
      `[whatsapp.doFetch${traceId ? `:${traceId}` : ""}] accountId=${accountId} path=${url.pathname}${url.search}`,
    );
    return stub.fetch(new Request(url.toString(), { ...init, headers }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Account control is only available through the service-binding RPC entrypoint.
    if (path === "/accounts" || path.startsWith("/account/")) {
      return new Response("Not Found", { status: 404 });
    }

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json({
        service: "gsv-channel-whatsapp",
        status: "ok",
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
