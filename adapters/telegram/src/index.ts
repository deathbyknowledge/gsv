import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import {
  resolveAdapterActivityRpcArgs,
  resolveAdapterConnectRpcArgs,
  resolveAdapterDisconnectRpcArgs,
  resolveAdapterSendRpcArgs,
  resolveAdapterStatusRpcArgs,
  type AdapterActivityRpcArgs,
  type AdapterConnectRpcArgs,
  type AdapterDisconnectRpcArgs,
  type AdapterSendRpcArgs,
  type AdapterStatusRpcArgs,
} from "../../shared/src/rpc-compat";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectConfig,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterPeerDeliveryContext,
  AdapterSendResult,
  AdapterService,
  AdapterServiceDescriptor,
  AdapterSurface,
  BinaryBody,
  GatewayFrame,
} from "./types";
import { parseTelegramWebhookPath } from "./webhook-route";
import {
  TelegramAccount,
  telegramUpdateSchema,
  type TelegramUpdate,
} from "./telegram-account";
import * as z from "zod/mini";

export { TelegramAccount };
export type * from "./types";

interface Env {
  TELEGRAM_ACCOUNT: DurableObjectNamespace<TelegramAccount>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_BASE_URL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const telegramConnectConfigSchema = z.strictObject({
  botToken: z.optional(z.string()),
  webhookBaseUrl: z.optional(z.string()),
  webhookSecret: z.optional(z.string()),
});
type TelegramConnectConfig = z.infer<typeof telegramConnectConfigSchema>;

type TelegramAccountReference = {
  id: DurableObjectId;
  account: DurableObjectStub<TelegramAccount>;
};

function toJsonError(message: string, status = 500): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export class TelegramChannel
  extends WorkerEntrypoint<Env>
  implements AdapterService
{
  readonly adapterId = "telegram";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "Telegram",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: true,
        pairing: false,
        deliveryFrames: true,
        surfaces: ["dm", "group", "channel", "thread"],
        media: {
          inbound: ["image", "audio", "video", "document"],
          outbound: ["image", "audio", "video", "document"],
        },
      },
    };
  }

  async adapterFrame(
    installation: AdapterInstallationContext,
    context: AdapterPeerDeliveryContext,
    frame: GatewayFrame,
    body?: BinaryBody,
  ): Promise<GatewayFrame | null> {
    const parsed = parseAdapterInstallationContext(installation);
    const { account } = this.getAccountDO(parsed, context.accountId);
    return await handleAdapterFrame(this.adapterId, parsed, context, frame, body, {
      send: async (message, requestBody) => await this.#adapterSendForInstallation(
        parsed,
        context.accountId,
        message,
        requestBody,
      ),
      acceptSignal: async (signalContext, signalFrame, signalBody) => {
        await account.acceptPeerSignal(parsed, signalContext, signalFrame, signalBody);
      },
    });
  }

  async adapterConnect(
    accountId: string,
    config?: AdapterConnectConfig,
  ): Promise<AdapterConnectResult>;
  async adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config?: AdapterConnectConfig,
  ): Promise<AdapterConnectResult>;
  async adapterConnect(...args: AdapterConnectRpcArgs): Promise<AdapterConnectResult> {
    const resolved = resolveAdapterConnectRpcArgs(args);
    const config = telegramConnectConfigSchema.safeParse(resolved.config);
    if (!config.success) {
      return { ok: false, error: "Telegram adapter config is invalid" };
    }
    return await this.#adapterConnectForInstallation(
      resolved.installation,
      resolved.accountId,
      config.data,
    );
  }

  async #adapterConnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    config: TelegramConnectConfig = {},
  ): Promise<AdapterConnectResult> {
    const botToken = config.botToken || this.env.TELEGRAM_BOT_TOKEN;
    const webhookBaseUrl = config.webhookBaseUrl || this.env.TELEGRAM_WEBHOOK_BASE_URL;
    const webhookSecret = config.webhookSecret || this.env.TELEGRAM_WEBHOOK_SECRET;

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

    let status: AdapterAccountStatus | undefined;
    try {
      [status] = await this.#adapterStatusForInstallation(installation, accountId);
    } catch {
      // start() completed authoritatively; the Gateway will preserve cached state
      // if its best-effort follow-up status query also fails.
    }
    return {
      ok: true,
      connected: status?.connected ?? true,
      authenticated: status?.authenticated ?? true,
      message: "Connected",
    };
  }

  async adapterDisconnect(
    accountId: string,
  ): Promise<AdapterDisconnectResult>;
  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult>;
  async adapterDisconnect(...args: AdapterDisconnectRpcArgs): Promise<AdapterDisconnectResult> {
    const resolved = resolveAdapterDisconnectRpcArgs(args);
    return await this.#adapterDisconnectForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterDisconnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const { account } = this.getAccountDO(parsedInstallation, accountId);
      await account.stop();
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async adapterStatus(
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(...args: AdapterStatusRpcArgs): Promise<AdapterAccountStatus[]> {
    const resolved = resolveAdapterStatusRpcArgs(args);
    return await this.#adapterStatusForInstallation(
      resolved.installation,
      resolved.accountId,
    );
  }

  async #adapterStatusForInstallation(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (!accountId) {
      // Account listing is not tracked yet.
      return [];
    }

    const { account } = this.getAccountDO(parsedInstallation, accountId);
    return [await account.getStatus()];
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
  async adapterSend(...args: AdapterSendRpcArgs): Promise<AdapterSendResult> {
    const resolved = await resolveAdapterSendRpcArgs(args);
    return await this.#adapterSendForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.message,
      resolved.body,
    );
  }

  async #adapterSendForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const { account } = this.getAccountDO(parsedInstallation, accountId);
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
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  async adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  async adapterSetActivity(
    ...args: AdapterActivityRpcArgs
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolved = resolveAdapterActivityRpcArgs(args);
    return await this.#adapterSetActivityForInstallation(
      resolved.installation,
      resolved.accountId,
      resolved.surface,
      resolved.activity,
    );
  }

  async #adapterSetActivityForInstallation(
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
      await account.setTyping(surface, activity.active);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private getAccountDO(
    installation: AdapterInstallationContext,
    accountId: string,
  ): TelegramAccountReference {
    const id = this.env.TELEGRAM_ACCOUNT.idFromName(
      adapterAccountDurableObjectName(installation, accountId),
    );
    return {
      id,
      account: this.env.TELEGRAM_ACCOUNT.get(id),
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
      const account = env.TELEGRAM_ACCOUNT.get(id);

      let updatePayload: TelegramUpdate;
      try {
        const parsed = telegramUpdateSchema.safeParse(await request.json());
        if (!parsed.success) return toJsonError("Invalid Telegram update payload", 400);
        updatePayload = parsed.data;
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
