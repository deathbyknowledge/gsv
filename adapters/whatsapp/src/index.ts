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

type ShellExecArgs = { input: string };
type ShellExecResult =
  | {
      status: "completed";
      output: string;
      exitCode: number;
      ok: true;
      pid: number;
      stdout: string;
      stderr: string;
    }
  | {
      status: "failed";
      output: string;
      error: string;
      exitCode: number;
      ok: false;
      pid: number;
      stdout: string;
      stderr: string;
    };

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
  readonly adapterId = "whatsapp";
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group"],
    media: true,
    reactions: true,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
    qrLogin: true,
  };

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks the RPC call before it
  // reaches this worker entrypoint.
  async adapterConnect(accountId: string, config: Record<string, unknown> = {}): Promise<
    | {
        ok: true;
        connected: boolean;
        authenticated: boolean;
        message?: string;
        challenge?: { type: string; message?: string; data?: string };
      }
    | { ok: false; error: string }
  > {
    const force = config.force === true || config.force === "true";
    const traceId =
      typeof config.__traceId === "string" && config.__traceId.trim().length > 0
        ? config.__traceId.trim()
        : "no-trace";
    console.log(
      `[whatsapp.connect:${traceId}] start accountId=${accountId} force=${force ? "true" : "false"}`,
    );
    const login = await this.login(accountId, { force, traceId });
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

  async connect(accountId: string, config: Record<string, unknown> = {}) {
    return this.adapterConnect(accountId, config);
  }

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  async adapterDisconnect(accountId: string): Promise<
    | { ok: true; message?: string }
    | { ok: false; error: string }
  > {
    const logout = await this.logout(accountId);
    if (!logout.ok) {
      return { ok: false, error: logout.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async disconnect(accountId: string) {
    return this.adapterDisconnect(accountId);
  }

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

  async adapterStatus(accountId?: string): Promise<ChannelAccountStatus[]> {
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

  async status(accountId?: string) {
    return this.adapterStatus(accountId);
  }

  async adapterSend(
    accountId: string,
    message: {
      surface: ChannelPeer;
      text: string;
      media?: ChannelOutboundMessage["media"];
      replyToId?: string;
    },
  ): Promise<SendResult> {
    try {
      console.log(`[WhatsAppEntrypoint] send() called for ${accountId} to ${message.surface.id}`);
      const outbound: ChannelOutboundMessage = {
        peer: message.surface,
        text: message.text,
        media: message.media,
        replyToId: message.replyToId,
      };
      const res = await this.doFetch(accountId, "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outbound),
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

  async send(accountId: string, message: ChannelOutboundMessage) {
    return this.adapterSend(accountId, {
      surface: message.peer,
      text: message.text,
      media: message.media,
      replyToId: message.replyToId,
    });
  }

  async adapterSetActivity(
    accountId: string,
    surface: ChannelPeer,
    activity: { kind: "typing" | "recording" | "uploading"; active: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      await this.setTyping(accountId, surface, activity.active);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
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

  async adapterReact(
    accountId: string,
    args: {
      surface: ChannelPeer;
      messageId: string;
      emoji: string;
      participant?: string;
    },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = await this.doFetch(accountId, "/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          peer: args.surface,
          messageId: args.messageId,
          emoji: args.emoji,
          participant: args.participant,
        }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      return data.success ? { ok: true } : { ok: false, error: data.error || "Failed to react" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async adapterShellExec(accountId: string, args: ShellExecArgs): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";

    if (isHelpCommand(command)) {
      return shellOk([
        "whatsapp adapter commands:",
        "  help | -h | --help",
        "  send <jid-or-phone> <text>",
        "  react <jid-or-phone> <message-id> <emoji> [participant-jid]",
        "  attach <jid-or-phone> <url> [--filename <name>] [caption]",
        "",
        "Normal back-and-forth replies should use the adapter conversation route.",
      ].join("\n"));
    }

    if (command === "send") {
      const [surfaceId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!surfaceId || !text) {
        return shellFail("usage: send <jid-or-phone> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: whatsappSurface(surfaceId),
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "react") {
      const [surfaceId, messageId, emoji, participant] = tokens.slice(1);
      if (!surfaceId || !messageId || emoji === undefined) {
        return shellFail("usage: react <jid-or-phone> <message-id> <emoji> [participant-jid]");
      }
      const result = await this.adapterReact(accountId, {
        surface: whatsappSurface(surfaceId),
        messageId,
        emoji,
        participant,
      });
      return result.ok ? shellOk("reacted") : shellFail(result.error);
    }

    if (command === "attach") {
      const { surfaceId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!surfaceId || !url) {
        return shellFail("usage: attach <jid-or-phone> <url> [--filename <name>] [caption]");
      }
      const media = await mediaFromUrl(url, filename);
      const result = await this.adapterSend(accountId, {
        surface: whatsappSurface(surfaceId),
        text: caption,
        media: [media],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      return shellFail("reply is handled by normal adapter conversation routing for WhatsApp");
    }

    return shellFail(`unknown command: ${command}`);
  }

  async login(accountId: string, options?: { force?: boolean; traceId?: string }): Promise<LoginResult> {
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

function parseShellWords(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.trim())) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

function isHelpCommand(command: string): boolean {
  return command === "help" || command === "-h" || command === "--help";
}

function parseAttachArgs(tokens: string[]): {
  surfaceId?: string;
  url?: string;
  filename?: string;
  caption: string;
} {
  const [surfaceId, url, ...rest] = tokens;
  if (rest.length === 0) {
    return { surfaceId, url, caption: "" };
  }

  if (rest[0] === "--filename" || rest[0] === "-f") {
    const [, filename, ...captionParts] = rest;
    return {
      surfaceId,
      url,
      filename,
      caption: captionParts.join(" ").trim(),
    };
  }

  const [candidate, ...captionParts] = rest;
  if (looksLikeFilename(candidate)) {
    return {
      surfaceId,
      url,
      filename: candidate,
      caption: captionParts.join(" ").trim(),
    };
  }

  return {
    surfaceId,
    url,
    caption: rest.join(" ").trim(),
  };
}

function looksLikeFilename(value: string | undefined): value is string {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  return /^[^/?#\s]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function whatsappSurface(id: string): ChannelPeer {
  const trimmed = id.trim();
  return {
    kind: trimmed.endsWith("@g.us") ? "group" : "dm",
    id: trimmed,
  };
}

async function mediaFromUrl(
  url: string,
  filename?: string,
): Promise<NonNullable<ChannelOutboundMessage["media"]>[number]> {
  let mimeType = "application/octet-stream";
  try {
    const response = await fetch(url, { method: "HEAD" });
    mimeType = response.headers.get("Content-Type")?.split(";")[0].trim() || mimeType;
  } catch {
    // The send path can still fetch the URL later; content type falls back.
  }

  return {
    type: mediaTypeFromMime(mimeType),
    mimeType,
    url,
    ...(filename ? { filename } : {}),
  };
}

function mediaTypeFromMime(mimeType: string): NonNullable<ChannelOutboundMessage["media"]>[number]["type"] {
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
