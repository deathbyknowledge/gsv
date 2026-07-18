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

export { DiscordGateway } from "./discord-gateway";

// Re-export interface types for consumers
export type * from "./types";

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace;
  // Secrets
  DISCORD_BOT_TOKEN?: string;
}

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Discord Channel Entrypoint
 * 
 * Gateway calls these methods via Service Binding.
 */
// Named export for service binding entrypoint
export class DiscordChannel extends WorkerEntrypoint<Env> implements AdapterWorkerInterface {
  readonly adapterId = "discord";

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks adapter RPC calls.
  async adapterConnect(
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    const configuredToken = typeof config.botToken === "string"
      ? config.botToken.trim()
      : "";
    const botToken = configuredToken || this.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { ok: false, error: "No bot token provided" };
    }

    try {
      const gateway = this.getGatewayDO(accountId);
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

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult> {
    try {
      const gateway = this.getGatewayDO(accountId);
      await gateway.stop();
      return { ok: true, message: "Disconnected" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get status of Discord connection(s).
   */
  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
    if (accountId) {
      const gateway = this.getGatewayDO(accountId);
      const state = await gateway.getStatus();
      return [state];
    }
    // TODO: Track all active accounts and return their statuses
    return [];
  }

  /**
   * Send a message to a Discord channel.
   */
  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
    binaryBody?: BinaryBody,
  ): Promise<AdapterSendResult> {
    const gateway = this.getGatewayDO(accountId);
    try {
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
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing" || !activity.active) {
      return { ok: true };
    }

    try {
      const botToken = await this.resolveBotToken(accountId);
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

  private getGatewayDO(accountId: string) {
    const id = this.env.DISCORD_GATEWAY.idFromName(accountId);
    return this.env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
  }

  private async resolveBotToken(accountId: string): Promise<string | null> {
    const gateway = this.getGatewayDO(accountId);
    const persistedToken = await gateway.getBotToken();
    return persistedToken || this.env.DISCORD_BOT_TOKEN || null;
  }

  private async discordFetch(
    path: string,
    init: RequestInit & { botToken: string }
  ): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bot ${init.botToken}`);
    const isFormDataBody = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (!headers.has("Content-Type") && init.body && !isFormDataBody) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    return await fetch(`${DISCORD_API}${path}`, { ...init, headers });
  }

}

// Type for DO stub methods
interface DiscordGatewayStub {
  start(botToken: string, accountId?: string): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<AdapterAccountStatus>;
  getBotToken(): Promise<string | null>;
  sendMessage(
    message: AdapterOutboundMessage,
    body?: BinaryBody,
  ): Promise<AdapterSendResult>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Default export: HTTP handler for direct requests
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
