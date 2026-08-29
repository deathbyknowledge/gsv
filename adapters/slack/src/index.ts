import { WorkerEntrypoint } from "cloudflare:workers";
import { cancelBinaryBody } from "../../shared/src/media-body";
import {
  adapterAccountDurableObjectName,
  parseAdapterInstallationContext,
} from "../../shared/src/installation";
import {
  resolveAdapterConnectRpcArgs,
  resolveAdapterDisconnectRpcArgs,
  resolveAdapterSendRpcArgs,
  resolveAdapterStatusRpcArgs,
  type AdapterConnectRpcArgs,
  type AdapterDisconnectRpcArgs,
  type AdapterSendRpcArgs,
  type AdapterStatusRpcArgs,
} from "../../shared/src/rpc-compat";
import type {
  AdapterAccountStatus,
  AdapterConnectConfig,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterService,
  AdapterServiceDescriptor,
  BinaryBody,
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
    const parsed = slackConnectConfigSchema.safeParse(resolved.config);
    if (!parsed.success) return { ok: false, error: "Slack adapter config is invalid" };
    return await this.connectAccount(
      resolved.installation,
      resolved.accountId,
      parsed.data,
    );
  }

  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult>;
  async adapterDisconnect(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult>;
  async adapterDisconnect(...args: AdapterDisconnectRpcArgs): Promise<AdapterDisconnectResult> {
    const resolved = resolveAdapterDisconnectRpcArgs(args);
    try {
      await this.account(resolved.installation, resolved.accountId).stop();
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]>;
  async adapterStatus(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]>;
  async adapterStatus(...args: AdapterStatusRpcArgs): Promise<AdapterAccountStatus[]> {
    const resolved = resolveAdapterStatusRpcArgs(args);
    if (!resolved.accountId) return [];
    return [await this.account(resolved.installation, resolved.accountId).getStatus()];
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
    try {
      return await this.account(
        resolved.installation,
        resolved.accountId,
      ).sendMessage(resolved.message, resolved.body);
    } catch (error) {
      await cancelBinaryBody(resolved.body, error);
      return {
        ok: false,
        error: "Slack delivery unavailable",
        retryable: true,
      };
    }
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
