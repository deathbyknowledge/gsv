import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import {
  adapterAccountDurableObjectName,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterConnectConfig,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterPeerDeliveryContext,
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
    installation: AdapterInstallationContext,
    accountId: string,
    inputConfig: AdapterConnectConfig = {},
  ): Promise<AdapterConnectResult> {
    const config = whatsappConnectConfigSchema.safeParse(inputConfig);
    if (!config.success) {
      return { ok: false, error: "WhatsApp adapter config is invalid" };
    }
    return await this.#adapterConnectForInstallation(
      installation,
      accountId,
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
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult> {
    return await this.#adapterDisconnectForInstallation(
      installation,
      accountId,
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
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    return await this.#adapterStatusForInstallation(
      installation,
      accountId,
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

  async adapterSetActivity(
    installation: AdapterInstallationContext,
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return await this.#adapterSetActivityForInstallation(
      installation,
      accountId,
      surface,
      activity,
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
