import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterCapabilities,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  ShellExecArgs,
  ShellExecResult,
} from "./types";

export { TelegramAccount } from "./telegram-account";
export type * from "./types";

interface Env {
  TELEGRAM_ACCOUNT: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_BASE_URL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

type WebhookResult = { ok: boolean; status?: number; error?: string };

type TelegramAccountStub = {
  start(
    botToken: string,
    accountId: string,
    webhookBaseUrl: string,
    webhookSecret?: string,
  ): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<AdapterAccountStatus>;
  sendMessage(
    message: AdapterOutboundMessage,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  setTyping(surface: AdapterSurface, typing: boolean): Promise<void>;
  handleWebhook(update: unknown, secretToken: string | null): Promise<WebhookResult>;
};

function accountFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/webhook\/([^/]+)$/);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function toJsonError(message: string, status = 500): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export class TelegramChannel
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "telegram";
  readonly channelId = "telegram";

  readonly capabilities: AdapterCapabilities = {
    chatTypes: ["dm", "group", "channel"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
  };

  async adapterConnect(
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    const started = await this.start(accountId, config);
    if (!started.ok) {
      return { ok: false, error: started.error };
    }

    const [status] = await this.adapterStatus(accountId);
    return {
      ok: true,
      connected: status?.connected ?? true,
      authenticated: status?.authenticated ?? true,
      message: "Connected",
    };
  }

  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult> {
    const stopped = await this.stop(accountId);
    if (!stopped.ok) {
      return { ok: false, error: stopped.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
    return this.status(accountId);
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
  ): Promise<AdapterSendResult> {
    return this.send(accountId, message);
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
      await this.setTyping(accountId, surface, activity.active);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async adapterShellExec(
    accountId: string,
    args: ShellExecArgs,
  ): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";

    if (isHelpCommand(command)) {
      return shellOk([
        "telegram adapter commands:",
        "  help | -h | --help",
        "  send <chat-id-or-handle> <text>",
        "  reply <chat-id-or-handle> <message-id> <text>",
        "  attach <chat-id-or-handle> <url> [--filename <name>] [caption]",
        "",
        "Normal back-and-forth replies should use the adapter conversation route.",
      ].join("\n"));
    }

    if (command === "send") {
      const [chatId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!chatId || !text) {
        return shellFail("usage: send <chat-id-or-handle> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      const [chatId, messageId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!chatId || !messageId || !text) {
        return shellFail("usage: reply <chat-id-or-handle> <message-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text,
        replyToId: messageId,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "attach") {
      const { chatId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!chatId || !url) {
        return shellFail(
          "usage: attach <chat-id-or-handle> <url> [--filename <name>] [caption]",
        );
      }
      const media = await mediaFromUrl(url, filename);
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text: caption,
        media: [media],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    return shellFail(`unknown command: ${command}`);
  }

  async start(
    accountId: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const botToken =
      (typeof config.botToken === "string" ? config.botToken : undefined) ||
      this.env.TELEGRAM_BOT_TOKEN;
    const webhookBaseUrl =
      (typeof config.webhookBaseUrl === "string"
        ? config.webhookBaseUrl
        : undefined) || this.env.TELEGRAM_WEBHOOK_BASE_URL;
    const webhookSecret =
      (typeof config.webhookSecret === "string" ? config.webhookSecret : undefined) ||
      this.env.TELEGRAM_WEBHOOK_SECRET;

    if (!botToken) {
      return {
        ok: false,
        error: "No Telegram bot token provided (set TELEGRAM_BOT_TOKEN or pass config.botToken)",
      };
    }

    if (!webhookBaseUrl) {
      return {
        ok: false,
        error:
          "No webhook base URL provided (set TELEGRAM_WEBHOOK_BASE_URL or pass config.webhookBaseUrl)",
      };
    }

    try {
      const account = this.getAccountDO(accountId);
      await account.start(botToken, accountId, webhookBaseUrl, webhookSecret);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(accountId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const account = this.getAccountDO(accountId);
      await account.stop();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(accountId?: string): Promise<AdapterAccountStatus[]> {
    if (!accountId) {
      // Account listing is not tracked yet.
      return [];
    }

    try {
      const account = this.getAccountDO(accountId);
      return [await account.getStatus()];
    } catch (error) {
      return [
        {
          accountId,
          connected: false,
          authenticated: false,
          mode: "webhook",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }

  async send(accountId: string, message: AdapterOutboundMessage): Promise<AdapterSendResult> {
    try {
      const account = this.getAccountDO(accountId);
      const result = await account.sendMessage(message);
      if (!result.ok) {
        return { ok: false, error: result.error || "Failed to send Telegram message" };
      }
      return { ok: true, messageId: result.messageId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setTyping(accountId: string, surface: AdapterSurface, typing: boolean): Promise<void> {
    try {
      const account = this.getAccountDO(accountId);
      await account.setTyping(surface, typing);
    } catch (error) {
      console.warn(`[TelegramChannel] setTyping failed for ${accountId}:`, error);
    }
  }

  private getAccountDO(accountId: string): TelegramAccountStub {
    const id = this.env.TELEGRAM_ACCOUNT.idFromName(accountId);
    return this.env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-telegram",
        status: "ok",
        hasBotToken: !!env.TELEGRAM_BOT_TOKEN,
        hasWebhookBaseUrl: !!env.TELEGRAM_WEBHOOK_BASE_URL,
      });
    }

    if (request.method === "POST") {
      const accountId = accountFromPath(url.pathname);
      if (!accountId) {
        return new Response("Not Found", { status: 404 });
      }

      const id = env.TELEGRAM_ACCOUNT.idFromName(accountId);
      const account = env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub;

      let updatePayload: unknown;
      try {
        updatePayload = await request.json();
      } catch {
        return toJsonError("Invalid JSON payload", 400);
      }

      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const result = await account.handleWebhook(updatePayload, secretToken);
      if (!result.ok) {
        return toJsonError(
          result.error || "Failed to handle Telegram webhook",
          result.status || 500,
        );
      }

      return Response.json({ ok: true });
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
  chatId?: string;
  url?: string;
  filename?: string;
  caption: string;
} {
  const [chatId, url, ...rest] = tokens;
  if (rest.length === 0) {
    return { chatId, url, caption: "" };
  }

  if (rest[0] === "--filename" || rest[0] === "-f") {
    const [, filename, ...captionParts] = rest;
    return {
      chatId,
      url,
      filename,
      caption: captionParts.join(" ").trim(),
    };
  }

  const [candidate, ...captionParts] = rest;
  if (looksLikeFilename(candidate)) {
    return {
      chatId,
      url,
      filename: candidate,
      caption: captionParts.join(" ").trim(),
    };
  }

  return {
    chatId,
    url,
    caption: rest.join(" ").trim(),
  };
}

function looksLikeFilename(value: string | undefined): value is string {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\")) return true;
  return /^[^/?#\s]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function telegramSurface(id: string): AdapterSurface {
  const trimmed = id.trim();
  if (trimmed.startsWith("@")) {
    return { kind: "channel", id: trimmed, handle: trimmed };
  }
  if (/^\d+$/.test(trimmed)) {
    return { kind: "dm", id: trimmed };
  }
  return { kind: "group", id: trimmed };
}

async function mediaFromUrl(url: string, filename?: string): Promise<AdapterMedia> {
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

function mediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
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
