import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
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
} from "../../shared/src/types";
import { errorFields, errorMessage, logWhatsApp } from "./logging";
import { WhatsAppAccount } from "./whatsapp-account";
import * as z from "zod/mini";

export { WhatsAppAccount } from "./whatsapp-account";
export type * from "./types";

const whatsappConnectConfigSchema = z.strictObject({
  force: z.optional(z.union([z.boolean(), z.string()])),
});
type WhatsAppConnectConfig = z.infer<typeof whatsappConnectConfigSchema>;

export class WhatsAppChannelEntrypoint
  extends WorkerEntrypoint<Env>
  implements AdapterService
{
  readonly adapterId = "whatsapp";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "WhatsApp",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: true,
        pairing: false,
        deliveryFrames: true,
        surfaces: ["dm", "group"],
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
    const account = this.getAccount(parsed, context.accountId);
    return await handleAdapterFrame(this.adapterId, parsed, context, frame, body, {
      send: async (message, requestBody) => await account.sendAccountMessage(
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
    const config = whatsappConnectConfigSchema.safeParse(resolved.config);
    if (!config.success) {
      return { ok: false, error: "WhatsApp adapter config is invalid" };
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
    config: WhatsAppConnectConfig = {},
  ): Promise<AdapterConnectResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const result = await this.getAccount(
        parsedInstallation,
        accountId,
      ).connectAccount(accountId, {
        force: config.force === true || config.force === "true",
      });
      if (!result.ok) return result;
      if (!result.connected) {
        return {
          ok: true,
          connected: false,
          authenticated: false,
          message: result.message,
          challenge: {
            type: "qr",
            format: "raw",
            message: result.message,
            data: result.qr,
            expiresAt: result.expiresAt,
          },
        };
      }
      return {
        ok: true,
        connected: true,
        authenticated: true,
        message: result.message,
      };
    } catch (error) {
      logWhatsApp("error", "connect_failed", errorFields(error));
      return { ok: false, error: errorMessage(error) };
    }
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
      await this.getAccount(
        parsedInstallation,
        accountId,
      ).disconnectAccount(accountId);
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      logWhatsApp("error", "disconnect_failed", errorFields(error));
      return { ok: false, error: errorMessage(error) };
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
    if (!accountId) return [];
    return [await this.getAccount(
      parsedInstallation,
      accountId,
    ).getAccountStatus(accountId)];
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
      return await this.getAccount(
        parsedInstallation,
        accountId,
      ).sendAccountMessage(
        accountId,
        message,
        body,
      );
    } catch (error) {
      await cancelBinaryBody(body, error);
      logWhatsApp("error", "send_failed", errorFields(error));
      return { ok: false, error: errorMessage(error), retryable: true };
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
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      await this.getAccount(
        parsedInstallation,
        accountId,
      ).setAccountActivity(
        accountId,
        surface,
        activity,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private getAccount(
    installation: AdapterInstallationContext,
    accountId: string,
  ): DurableObjectStub<WhatsAppAccount> {
    return this.env.WHATSAPP_ACCOUNT.getByName(
      adapterAccountDurableObjectName(installation, accountId),
    );
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/health") {
      return Response.json({ service: "gsv-channel-whatsapp", status: "ok" });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
