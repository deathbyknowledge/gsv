/**
 * GSV Discord Adapter Worker
 * 
 * Implements the canonical adapter service-binding interface for Discord.
 * Uses a Durable Object (DiscordGateway) to maintain persistent WebSocket
 * connection to Discord's Gateway API.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  cancelResponseBody,
  cancelBinaryBody,
} from "../../shared/src/media-body";
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
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  BinaryBody,
} from "../../shared/src/types";
import { DiscordGateway } from "./discord-gateway";
import * as z from "zod/mini";

export { DiscordGateway };

// Re-export interface types for consumers
export type * from "./types";

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  // Secrets
  DISCORD_BOT_TOKEN?: string;
}

const DISCORD_API = "https://discord.com/api/v10";

const discordConnectConfigSchema = z.strictObject({
  botToken: z.optional(z.string()),
});
type DiscordConnectConfig = z.infer<typeof discordConnectConfigSchema>;

/**
 * Discord Channel Entrypoint
 * 
 * Gateway calls these methods via Service Binding.
 */
// Named export for service binding entrypoint
export class DiscordChannel extends WorkerEntrypoint<Env> implements AdapterWorkerInterface {
  readonly adapterId = "discord";

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
    const config = discordConnectConfigSchema.safeParse(resolved.config);
    if (!config.success) {
      return { ok: false, error: "Discord adapter config is invalid" };
    }
    return await this.#adapterConnectForInstallation(
      resolved.installation,
      resolved.accountId,
      config.data,
    );
  }

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks adapter RPC calls.
  async #adapterConnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    config: DiscordConnectConfig = {},
  ): Promise<AdapterConnectResult> {
    const configuredToken = config.botToken?.trim() ?? "";
    const botToken = configuredToken || this.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { ok: false, error: "No bot token provided" };
    }

    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const gateway = this.getGatewayDO(parsedInstallation, accountId);
      await gateway.start(botToken, accountId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      connected: true,
      authenticated: true,
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

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  async #adapterDisconnectForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<AdapterDisconnectResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const gateway = this.getGatewayDO(parsedInstallation, accountId);
      await gateway.stop();
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

  /**
   * Get status of Discord connection(s).
   */
  async #adapterStatusForInstallation(
    installation: AdapterInstallationContext,
    accountId?: string,
  ): Promise<AdapterAccountStatus[]> {
    const parsedInstallation = parseAdapterInstallationContext(installation);
    if (accountId) {
      const gateway = this.getGatewayDO(parsedInstallation, accountId);
      const state = await gateway.getStatus();
      return [state];
    }
    // TODO: Track all active accounts and return their statuses
    return [];
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    binaryBody?: BinaryBody,
  ): Promise<AdapterSendResult>;
  async adapterSend(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    binaryBody?: BinaryBody,
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

  /**
   * Send a message to a Discord channel.
   */
  async #adapterSendForInstallation(
    installation: AdapterInstallationContext,
    accountId: string,
    message: AdapterOutboundMessage,
    binaryBody?: BinaryBody,
  ): Promise<AdapterSendResult> {
    try {
      const parsedInstallation = parseAdapterInstallationContext(installation);
      const gateway = this.getGatewayDO(parsedInstallation, accountId);
      return await gateway.sendMessage(message, binaryBody);
    } catch (error) {
      await cancelBinaryBody(binaryBody, error);
      return {
        ok: false,
        error: `Discord delivery unavailable: ${toErrorMessage(error)}`,
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
    if (activity.kind !== "typing" || !activity.active) {
      return { ok: true };
    }

    try {
      const botToken = await this.resolveBotToken(parsedInstallation, accountId);
      if (!botToken) {
        return { ok: true };
      }
      const response = await this.discordFetch(`/channels/${surface.id}/typing`, {
        method: "POST",
        botToken,
      });
      await cancelResponseBody(response, "Discord typing response consumed");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ─────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────

  private getGatewayDO(
    installation: AdapterInstallationContext,
    accountId: string,
  ): DiscordGatewayStub {
    const id = this.env.DISCORD_GATEWAY.idFromName(
      adapterAccountDurableObjectName(installation, accountId),
    );
    return this.env.DISCORD_GATEWAY.get(id);
  }

  private async resolveBotToken(
    installation: AdapterInstallationContext,
    accountId: string,
  ): Promise<string | null> {
    const gateway = this.getGatewayDO(installation, accountId);
    const persistedToken = await gateway.getBotToken();
    return persistedToken || this.env.DISCORD_BOT_TOKEN || null;
  }

  private async discordFetch(
    path: string,
    init: RequestInit & { botToken: string }
  ): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bot ${init.botToken}`);
    const isFormDataBody = init.body instanceof FormData;
    if (!headers.has("Content-Type") && init.body && !isFormDataBody) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    return await fetch(`${DISCORD_API}${path}`, { ...init, headers });
  }

}

// Type for DO stub methods
type DiscordGatewayStub = DurableObjectStub<DiscordGateway>;

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Default export: HTTP handler for direct requests
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        service: "gsv-channel-discord",
        status: "ok",
      });
    }

    // Adapter setup, lifecycle, and account status are service-binding only.
    if (url.pathname === "/setup" || url.pathname === "/start" || url.pathname === "/stop" || url.pathname === "/status") {
      return new Response("Not Found", { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
