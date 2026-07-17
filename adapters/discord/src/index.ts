/**
 * GSV Discord Channel Worker
 * 
 * Implements ChannelWorkerInterface for Discord integration.
 * Uses a Durable Object (DiscordGateway) to maintain persistent WebSocket
 * connection to Discord's Gateway API.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { normalizeAdapterAccountId } from "@humansandmachines/gsv/protocol/adapters";
import {
  inferMediaMimeType,
  isHelpCommand,
  parseAttachArgs,
  parseShellWords,
} from "../../shared/src/command";
import type {
  ShellExecArgs,
  ShellExecResult,
} from "../../shared/src/types";
import type {
  ChannelWorkerInterface,
  ChannelCapabilities,
  ChannelMedia,
  ChannelAccountStatus,
  ChannelOutboundMessage,
  ChannelPeer,
  StartResult,
  StopResult,
  SendResult,
} from "./types";
import {
  describeManagedAdapterAccounts,
  assertManagedAdapterDescriptorRequest,
  runManagedLifecycleAction,
} from "../../shared/src/managed-lifecycle";
import {
  restoreManagedAdapterAccount,
  snapshotManagedAdapterAccount,
} from "../../shared/src/managed-portability";
import {
  MANAGED_ADMISSION_GATE_NAME,
  ManagedAdmissionGate,
  describeManagedAdmissionObjects,
  runWithManagedAdmission,
} from "../../shared/src/managed-admission";
import type { DiscordGateway } from "./discord-gateway";

export { DiscordGateway } from "./discord-gateway";
export { ManagedAdmissionGate } from "../../shared/src/managed-admission";

// Re-export interface types for consumers
export type * from "./types";

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  MANAGED_ADMISSION: DurableObjectNamespace<ManagedAdmissionGate>;
  // Secrets
  DISCORD_BOT_TOKEN?: string;
}

/**
 * Discord Channel Entrypoint
 * 
 * Gateway calls these methods via Service Binding.
 */
// Named export for service binding entrypoint
export class DiscordChannel extends WorkerEntrypoint<Env> implements ChannelWorkerInterface {
  readonly channelId = "discord";
  readonly adapterId = "discord";
  
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ["dm", "group", "channel", "thread"],
    media: true,
    reactions: true,
    threads: true,
    typing: true,
    editing: true,
    deletion: true,
  };

  async managedPause(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedPause", (accountId) =>
      this.getGatewayDO(accountId),
    );
  }

  async managedResume(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedResume", (accountId) =>
      this.getGatewayDO(accountId),
    );
  }

  async managedErase(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedErase", (accountId) =>
      this.getGatewayDO(accountId),
    );
  }

  async managedDescribeObjects(input: unknown) {
    assertManagedAdapterDescriptorRequest(input);
    return input.kind === "adapter_account"
      ? describeManagedAdapterAccounts(this.env.DISCORD_GATEWAY, input.providerIds)
      : describeManagedAdmissionObjects(this.env.MANAGED_ADMISSION, input.providerIds);
  }

  async managedSnapshot(input: unknown) {
    return snapshotManagedAdapterAccount(this.env.DISCORD_GATEWAY, "discord", input);
  }

  async managedRestore(input: unknown, stream: ReadableStream<Uint8Array>) {
    return restoreManagedAdapterAccount(
      this.env.DISCORD_GATEWAY,
      "discord",
      input,
      stream,
    );
  }

  async managedFenceAll() {
    return this.managedAdmission().managedFenceAll();
  }

  async managedResumeAll() {
    return this.managedAdmission().managedResumeAll();
  }

  async managedEraseAll() {
    return this.managedAdmission().managedEraseAll();
  }

  /**
   * Canonical adapter lifecycle entrypoint used by gateway.
   */
  // DONT RENAME TO connect() because Cloudflare service bindings already expose
  // a built-in socket connect() method, which hijacks adapter RPC calls.
  async adapterConnect(accountId: string, config: Record<string, unknown> = {}): Promise<
    | { ok: true; connected: boolean; authenticated: boolean; message?: string }
    | { ok: false; error: string }
  > {
    const started = await this.start(accountId, config);
    if (!started.ok) {
      return { ok: false, error: started.error };
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
  async adapterDisconnect(accountId: string): Promise<
    | { ok: true; message?: string }
    | { ok: false; error: string }
  > {
    const stopped = await this.stop(accountId);
    if (!stopped.ok) {
      return { ok: false, error: stopped.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async disconnect(accountId: string) {
    return this.adapterDisconnect(accountId);
  }

  /**
   * Start Discord Gateway connection for an account.
   */
  async start(accountId: string, config: Record<string, unknown>): Promise<StartResult> {
    const botToken = (config.botToken as string) || this.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return { ok: false, error: "No bot token provided" };
    }

    try {
      return await this.withManagedAdmission(`start:${accountId}`, async () => {
        const gateway = this.getGatewayDO(accountId);
        await gateway.start(botToken, accountId);
        return { ok: true };
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Stop Discord Gateway connection.
   */
  async stop(accountId: string): Promise<StopResult> {
    try {
      return await this.withManagedAdmission(`stop:${accountId}`, async () => {
        const gateway = this.getGatewayDO(accountId);
        await gateway.stop();
        return { ok: true };
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Get status of Discord connection(s).
   */
  async adapterStatus(accountId?: string): Promise<ChannelAccountStatus[]> {
    if (accountId) {
      const gateway = this.getGatewayDO(accountId);
      const state = await gateway.getStatus();
      return [state];
    }
    // TODO: Track all active accounts and return their statuses
    return [];
  }

  async status(accountId?: string) {
    return this.adapterStatus(accountId);
  }

  /**
   * Send a message to a Discord channel.
   */
  async adapterSend(
    accountId: string,
    message: {
      surface: ChannelPeer;
      text: string;
      media?: ChannelMedia[];
      replyToId?: string;
    },
  ): Promise<SendResult> {
    try {
      return await this.withManagedAdmission(`send:${accountId}`, async () => {
        const result = await this.getGatewayDO(accountId).sendMessage({
          surface: message.surface,
          text: message.text,
          media: message.media,
          replyToId: message.replyToId,
        });
        return result.ok
          ? { ok: true, messageId: result.messageId }
          : { ok: false, error: result.error || "Failed to send Discord message" };
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(accountId: string, message: ChannelOutboundMessage) {
    return this.adapterSend(accountId, {
      surface: message.peer,
      text: message.text,
      media: message.media,
      replyToId: message.replyToId,
    });
  }

  async adapterSetActivity(
    accountId: string,
    surface: ChannelPeer,
    activity: { kind: "typing" | "recording" | "uploading"; active: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      await this.setTyping(accountId, surface, activity.active);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Send typing indicator.
   */
  async setTyping(accountId: string, peer: ChannelPeer, typing: boolean): Promise<void> {
    if (!typing) return; // Discord doesn't have "stop typing"

    await this.withManagedAdmission(`typing:${accountId}`, () =>
      this.getGatewayDO(accountId).setTyping(peer),
    );
  }

  async adapterShellExec(accountId: string, args: ShellExecArgs): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";

    if (isHelpCommand(command)) {
      return shellOk([
        "discord adapter commands:",
        "  help | -h | --help",
        "  send <channel-id> <text>",
        "  reply <channel-id> <message-id> <text>",
        "  react <channel-id> <message-id> <emoji>",
        "  attach <channel-id> <url> [--filename <name>] [caption]",
      ].join("\n"));
    }

    if (command === "send") {
      const [channelId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!channelId || !text) {
        return shellFail("usage: send <channel-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      const [channelId, messageId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!channelId || !messageId || !text) {
        return shellFail("usage: reply <channel-id> <message-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text,
        replyToId: messageId,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "react") {
      const [channelId, messageId, emoji] = tokens.slice(1);
      if (!channelId || !messageId || !emoji) {
        return shellFail("usage: react <channel-id> <message-id> <emoji>");
      }
      const result = await this.withManagedAdmission<
        { ok: true } | { ok: false; error: string }
      >(
        `react:${accountId}`,
        () => this.getGatewayDO(accountId).react(
          channelId,
          messageId,
          emoji,
        ) as unknown as Promise<{ ok: true } | { ok: false; error: string }>,
      );
      return result.ok ? shellOk("reacted") : shellFail(result.error);
    }

    if (command === "attach") {
      const { targetId: channelId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!channelId || !url) {
        return shellFail("usage: attach <channel-id> <url> [--filename <name>] [caption]");
      }
      const media = await mediaFromUrl(url, filename);
      const result = await this.adapterSend(accountId, {
        surface: discordSurface(channelId),
        text: caption,
        media: [media],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    return shellFail(`unknown command: ${command}`);
  }

  // ─────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────

  private getGatewayDO(accountId: string) {
    const normalized = normalizeAdapterAccountId(accountId);
    if (!normalized) throw new TypeError("Discord account ID is invalid");
    const id = this.env.DISCORD_GATEWAY.idFromName(normalized);
    return this.env.DISCORD_GATEWAY.get(id);
  }

  private managedAdmission() {
    return this.env.MANAGED_ADMISSION.getByName(MANAGED_ADMISSION_GATE_NAME);
  }

  private withManagedAdmission<T>(
    owner: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runWithManagedAdmission(this.env.MANAGED_ADMISSION, owner, operation);
  }
}

function discordSurface(id: string): ChannelPeer {
  return { kind: "channel", id: id.trim() };
}

async function mediaFromUrl(url: string, filename?: string): Promise<ChannelMedia> {
  const mimeType = inferMediaMimeType(url, filename);

  return {
    type: mediaTypeFromMime(mimeType),
    mimeType,
    url,
    ...(filename ? { filename } : {}),
  };
}

function mediaTypeFromMime(mimeType: string): ChannelMedia["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function shellOk(output: string): ShellExecResult {
  return {
    status: "completed",
    output,
    exitCode: 0,
    ok: true,
    pid: 0,
    stdout: output,
    stderr: "",
  };
}

function shellFail(error: string): ShellExecResult {
  return {
    status: "failed",
    output: error,
    error,
    exitCode: 1,
    ok: false,
    pid: 0,
    stdout: "",
    stderr: error,
  };
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
