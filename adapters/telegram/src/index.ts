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
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
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

  async adapterConnect(
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
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
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
    try {
      const account = this.getAccountDO(accountId);
      await account.stop();
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
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

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      const account = this.getAccountDO(accountId);
      const result = await account.sendMessage(message, body);
      return result;
    } catch (error) {
      await cancelBinaryBody(body, error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
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
      const account = this.getAccountDO(accountId);
      await account.setTyping(surface, activity.active);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
