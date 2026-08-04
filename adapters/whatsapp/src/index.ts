import { WorkerEntrypoint } from "cloudflare:workers";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
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
} from "../../shared/src/types";
import { errorFields, errorMessage, logWhatsApp } from "./logging";
import { WhatsAppAccount } from "./whatsapp-account";

export { WhatsAppAccount } from "./whatsapp-account";
export type * from "./types";

export class WhatsAppChannelEntrypoint
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "whatsapp";

  async adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const result = await this.getAccount(
        parsedInstallation,
        accountId,
      ).connectAccount(parsedInstallation.installationId, accountId, {
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
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      await this.getAccount(
        parsedInstallation,
        accountId,
      ).disconnectAccount(parsedInstallation.installationId, accountId);
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
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (!accountId) return [];
    try {
      return [await this.getAccount(
        parsedInstallation,
        accountId,
      ).getAccountStatus(parsedInstallation.installationId, accountId)];
    } catch (error) {
      return [{
        accountId,
        connected: false,
        authenticated: false,
        mode: "websocket",
        error: errorMessage(error),
      }];
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
      return await this.getAccount(
        parsedInstallation,
        accountId,
      ).sendAccountMessage(
        parsedInstallation.installationId,
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
        parsedInstallation.installationId,
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
