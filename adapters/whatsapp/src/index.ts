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
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    try {
      const result = await this.getAccount(accountId).connectAccount(accountId, {
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

  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult> {
    try {
      await this.getAccount(accountId).disconnectAccount(accountId);
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      logWhatsApp("error", "disconnect_failed", errorFields(error));
      return { ok: false, error: errorMessage(error) };
    }
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
    if (!accountId) return [];
    try {
      return [await this.getAccount(accountId).getAccountStatus(accountId)];
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
    accountId: string,
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      return await this.getAccount(accountId).sendAccountMessage(accountId, message, body);
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
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.getAccount(accountId).setAccountActivity(accountId, surface, activity);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private getAccount(accountId: string): DurableObjectStub<WhatsAppAccount> {
    return this.env.WHATSAPP_ACCOUNT.getByName(accountId);
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
