import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ChannelAccountStatus,
  ChannelCapabilities,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelWorkerInterface,
  SendResult,
  StartResult,
  StopResult,
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
  getStatus(): Promise<ChannelAccountStatus>;
  sendMessage(
    message: ChannelOutboundMessage,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  setTyping(peer: ChannelPeer, typing: boolean): Promise<void>;
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
  implements ChannelWorkerInterface
{
  readonly channelId = "telegram";

  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group", "channel"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
  };

  async start(
    accountId: string,
    config: Record<string, unknown>,
  ): Promise<StartResult> {
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

  async stop(accountId: string): Promise<StopResult> {
    try {
      const account = this.getAccountDO(accountId);
      await account.stop();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(accountId?: string): Promise<ChannelAccountStatus[]> {
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

  async send(accountId: string, message: ChannelOutboundMessage): Promise<SendResult> {
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

  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    try {
      const account = this.getAccountDO(accountId);
      await account.setTyping(peer, typing);
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
      if (accountId) {
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

      if (url.pathname === "/start") {
        const accountId = url.searchParams.get("accountId") || "default";
        const botToken = env.TELEGRAM_BOT_TOKEN;
        const webhookBaseUrl = env.TELEGRAM_WEBHOOK_BASE_URL;
        if (!botToken || !webhookBaseUrl) {
          return toJsonError(
            "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_BASE_URL are required",
            400,
          );
        }
        const id = env.TELEGRAM_ACCOUNT.idFromName(accountId);
        const account = env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub;
        try {
          await account.start(
            botToken,
            accountId,
            webhookBaseUrl,
            env.TELEGRAM_WEBHOOK_SECRET,
          );
          return Response.json({ ok: true });
        } catch (error) {
          return toJsonError(
            error instanceof Error ? error.message : String(error),
            500,
          );
        }
      }

      if (url.pathname === "/stop") {
        const accountId = url.searchParams.get("accountId") || "default";
        const id = env.TELEGRAM_ACCOUNT.idFromName(accountId);
        const account = env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub;
        try {
          await account.stop();
          return Response.json({ ok: true });
        } catch (error) {
          return toJsonError(
            error instanceof Error ? error.message : String(error),
            500,
          );
        }
      }
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const accountId = url.searchParams.get("accountId") || "default";
      const id = env.TELEGRAM_ACCOUNT.idFromName(accountId);
      const account = env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub;
      try {
        const status = await account.getStatus();
        return Response.json(status);
      } catch (error) {
        return toJsonError(error instanceof Error ? error.message : String(error), 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
