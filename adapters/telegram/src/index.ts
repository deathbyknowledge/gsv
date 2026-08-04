import { WorkerEntrypoint } from "cloudflare:workers";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
} from "./types";
import { parseTelegramWebhookPath } from "./webhook-route";

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
    installationId: string,
    botToken: string,
    accountId: string,
    webhookBaseUrl: string,
    webhookRoute: string,
    webhookSecret?: string,
  ): Promise<void>;
  stop(installationId: string): Promise<void>;
  getStatus(installationId: string): Promise<AdapterAccountStatus>;
  sendMessage(
    installationId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  setTyping(
    installationId: string,
    surface: AdapterSurface,
    typing: boolean,
  ): Promise<void>;
  handleWebhook(update: unknown, secretToken: string | null): Promise<WebhookResult>;
};

function toJsonError(message: string, status = 500): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export class TelegramChannel
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "telegram";

  async adapterConnect(
    installation: AdapterInstallationContext,
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
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const { account, id } = this.getAccountDO(parsedInstallation, accountId);
      const webhookRoute = parsedInstallation.installationId
        === LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
        ? accountId
        : id.toString();
      await account.start(
        parsedInstallation.installationId,
        botToken,
        accountId,
        webhookBaseUrl,
        webhookRoute,
        webhookSecret,
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const [status] = await this.adapterStatus(installation, accountId);
    return {
      ok: true,
      connected: status?.connected ?? true,
      authenticated: status?.authenticated ?? true,
      message: "Connected",
    };
  }

  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const { account } = this.getAccountDO(parsedInstallation, accountId);
      await account.stop(parsedInstallation.installationId);
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (!accountId) {
      // Account listing is not tracked yet.
      return [];
    }

    try {
      const { account } = this.getAccountDO(parsedInstallation, accountId);
      return [await account.getStatus(parsedInstallation.installationId)];
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
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const { account } = this.getAccountDO(parsedInstallation, accountId);
      const result = await account.sendMessage(
        parsedInstallation.installationId,
        message,
        body,
      );
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
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      const { account } = this.getAccountDO(parsedInstallation, accountId);
      await account.setTyping(
        parsedInstallation.installationId,
        surface,
        activity.active,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private getAccountDO(
    installation: AdapterInstallationContext,
    accountId: string,
  ): { id: DurableObjectId; account: TelegramAccountStub } {
    const id = this.env.TELEGRAM_ACCOUNT.idFromName(
      adapterAccountDurableObjectName(installation, accountId),
    );
    return {
      id,
      account: this.env.TELEGRAM_ACCOUNT.get(id) as unknown as TelegramAccountStub,
    };
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
      const route = parseTelegramWebhookPath(url.pathname);
      if (!route) {
        return new Response("Not Found", { status: 404 });
      }

      let id: DurableObjectId;
      try {
        id = route.kind === "opaque"
          ? env.TELEGRAM_ACCOUNT.idFromString(route.durableObjectId)
          : env.TELEGRAM_ACCOUNT.idFromName(route.accountId);
      } catch {
        return new Response("Not Found", { status: 404 });
      }
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
