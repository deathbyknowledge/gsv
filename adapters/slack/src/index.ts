import { WorkerEntrypoint } from "cloudflare:workers";
import { handleAdapterFrame } from "../../shared/src/adapter-frame";
import {
  adapterAccountDurableObjectName,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import type {
  AdapterAccountStatus,
  AdapterConnectConfig,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterDeliveryContext,
  AdapterService,
  AdapterServiceDescriptor,
  GatewayRequestFrame,
  GatewayResponseFrame,
} from "./types";
import { SlackAccount } from "./slack-account";
import * as z from "zod/mini";

export { SlackAccount };

interface Env {
  SLACK_ACCOUNT: DurableObjectNamespace<SlackAccount>;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
}

const slackConnectConfigSchema = z.strictObject({
  botToken: z.optional(z.string()),
  appToken: z.optional(z.string()),
});
type SlackConnectConfig = z.infer<typeof slackConnectConfigSchema>;

export class SlackChannel extends WorkerEntrypoint<Env> implements AdapterService {
  readonly adapterId = "slack";

  async adapterDescribe(): Promise<AdapterServiceDescriptor> {
    return {
      version: 1,
      id: this.adapterId,
      displayName: "Slack",
      capabilities: {
        connect: true,
        disconnect: true,
        send: true,
        status: true,
        activity: false,
        pairing: false,
        surfaces: ["dm", "channel", "thread"],
        media: {
          inbound: ["image", "audio", "video", "document"],
          outbound: ["image", "audio", "video", "document"],
        },
      },
    };
  }

  async adapterFrame(
    installation: AdapterInstallationContext,
    context: AdapterDeliveryContext,
    frame: GatewayRequestFrame,
  ): Promise<GatewayResponseFrame> {
    const parsed = parseAdapterInstallationContext(installation);
    const account = this.account(parsed, context.accountId);
    return await handleAdapterFrame(this.adapterId, context, frame, {
      send: async (delivery, requestBody) => {
        return await account.sendRoutedMessage(context, delivery, requestBody);
      },
    });
  }

  async adapterConnect(
    installation: AdapterInstallationContext,
    accountId: string,
    inputConfig: AdapterConnectConfig = {},
  ): Promise<AdapterConnectResult> {
    const parsed = slackConnectConfigSchema.safeParse(inputConfig);
    if (!parsed.success) return { ok: false, error: "Slack adapter config is invalid" };
    return await this.connectAccount(
      installation,
      accountId,
      parsed.data,
    );
  }

  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult> {
    try {
      await this.account(installation, accountId).stop();
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    if (!accountId) return [];
    return [await this.account(installation, accountId).getStatus()];
  }

  private async connectAccount(
    installation: AdapterInstallationContext,
    accountId: string,
    config: SlackConnectConfig,
  ): Promise<AdapterConnectResult> {
    const botToken = config.botToken?.trim() || this.env.SLACK_BOT_TOKEN?.trim();
    const appToken = config.appToken?.trim() || this.env.SLACK_APP_TOKEN?.trim();
    if (!botToken || !appToken) {
      return {
        ok: false,
        error: "Slack requires both a bot token and a Socket Mode app token",
      };
    }
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const account = this.account(parsedInstallation, accountId);
      await account.start(botToken, appToken, accountId);
      const status = await account.getStatus();
      return {
        ok: true,
        connected: status.connected,
        authenticated: status.authenticated,
        message: "Connected",
      };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  private account(
    installation: AdapterInstallationContext,
    accountId: string,
  ): DurableObjectStub<SlackAccount> {
    const parsed = parseAdapterInstallationContext(installation);
    const id = this.env.SLACK_ACCOUNT.idFromName(
      adapterAccountDurableObjectName(parsed, accountId),
    );
    return this.env.SLACK_ACCOUNT.get(id);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return Response.json({ service: "gsv-channel-slack", status: "ok" });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function safeError<T>(error: T): string {
  const message = error instanceof Error ? error.message : String(error);
  return /Slack|token|account|installation|Socket/.test(message)
    ? message
    : "Slack adapter request failed";
}
