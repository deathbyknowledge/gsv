import { WorkerEntrypoint } from "cloudflare:workers";
import { normalizeAdapterAccountId } from "@humansandmachines/gsv/protocol/adapters";
import {
  inferMediaMimeType,
  isHelpCommand,
  parseAttachArgs,
  parseShellWords,
} from "../../shared/src/command";
import type {
  AdapterAccountStatus,
  AdapterActivity,
  AdapterCapabilities,
  AdapterConnectResult,
  AdapterDisconnectResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  AdapterWorkerInterface,
  ShellExecArgs,
  ShellExecResult,
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
  ManagedAdmissionUnavailableError,
  describeManagedAdmissionObjects,
  runWithManagedAdmission,
} from "../../shared/src/managed-admission";
import type { TelegramAccount } from "./telegram-account";
import { handleTelegramWebhookRequest } from "./webhook-handler";

export { TelegramAccount } from "./telegram-account";
export { ManagedAdmissionGate } from "../../shared/src/managed-admission";
export type * from "./types";

interface Env {
  TELEGRAM_ACCOUNT: DurableObjectNamespace<TelegramAccount>;
  MANAGED_ADMISSION: DurableObjectNamespace<ManagedAdmissionGate>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_BASE_URL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

function accountFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/webhook\/([^/]+)$/);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export class TelegramChannel
  extends WorkerEntrypoint<Env>
  implements AdapterWorkerInterface
{
  readonly adapterId = "telegram";
  readonly channelId = "telegram";

  readonly capabilities: AdapterCapabilities = {
    chatTypes: ["dm", "group", "channel"],
    media: true,
    reactions: false,
    threads: false,
    typing: true,
    editing: false,
    deletion: false,
  };

  async managedPause(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedPause", (accountId) =>
      this.getAccountDO(accountId),
    );
  }

  async managedResume(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedResume", (accountId) =>
      this.getAccountDO(accountId),
    );
  }

  async managedErase(accountIds: string[]): Promise<{ accountIds: string[] }> {
    return runManagedLifecycleAction(accountIds, "managedErase", (accountId) =>
      this.getAccountDO(accountId),
    );
  }

  async managedDescribeObjects(input: unknown) {
    assertManagedAdapterDescriptorRequest(input);
    return input.kind === "adapter_account"
      ? describeManagedAdapterAccounts(this.env.TELEGRAM_ACCOUNT, input.providerIds)
      : describeManagedAdmissionObjects(this.env.MANAGED_ADMISSION, input.providerIds);
  }

  async managedSnapshot(input: unknown) {
    return snapshotManagedAdapterAccount(this.env.TELEGRAM_ACCOUNT, "telegram", input);
  }

  async managedRestore(input: unknown, stream: ReadableStream<Uint8Array>) {
    return restoreManagedAdapterAccount(
      this.env.TELEGRAM_ACCOUNT,
      "telegram",
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

  async adapterConnect(
    accountId: string,
    config: Record<string, unknown> = {},
  ): Promise<AdapterConnectResult> {
    const started = await this.start(accountId, config);
    if (!started.ok) {
      return { ok: false, error: started.error };
    }

    const [status] = await this.adapterStatus(accountId);
    return {
      ok: true,
      connected: status?.connected ?? true,
      authenticated: status?.authenticated ?? true,
      message: "Connected",
    };
  }

  async adapterDisconnect(accountId: string): Promise<AdapterDisconnectResult> {
    const stopped = await this.stop(accountId);
    if (!stopped.ok) {
      return { ok: false, error: stopped.error };
    }
    return { ok: true, message: "Disconnected" };
  }

  async adapterStatus(accountId?: string): Promise<AdapterAccountStatus[]> {
    return this.status(accountId);
  }

  async adapterSend(
    accountId: string,
    message: AdapterOutboundMessage,
  ): Promise<AdapterSendResult> {
    return this.send(accountId, message);
  }

  async adapterSetActivity(
    accountId: string,
    surface: AdapterSurface,
    activity: AdapterActivity,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (activity.kind !== "typing") {
      return { ok: true };
    }

    try {
      await this.setTyping(accountId, surface, activity.active);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async adapterShellExec(
    accountId: string,
    args: ShellExecArgs,
  ): Promise<ShellExecResult> {
    const tokens = parseShellWords(args.input);
    const command = tokens[0] ?? "help";

    if (isHelpCommand(command)) {
      return shellOk([
        "telegram adapter commands:",
        "  help | -h | --help",
        "  send <chat-id-or-handle> <text>",
        "  reply <chat-id-or-handle> <message-id> <text>",
        "  attach <chat-id-or-handle> <url> [--filename <name>] [caption]",
        "",
        "Normal back-and-forth replies should use the adapter conversation route.",
      ].join("\n"));
    }

    if (command === "send") {
      const [chatId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!chatId || !text) {
        return shellFail("usage: send <chat-id-or-handle> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "reply") {
      const [chatId, messageId, ...textParts] = tokens.slice(1);
      const text = textParts.join(" ").trim();
      if (!chatId || !messageId || !text) {
        return shellFail("usage: reply <chat-id-or-handle> <message-id> <text>");
      }
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text,
        replyToId: messageId,
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    if (command === "attach") {
      const { targetId: chatId, url, filename, caption } = parseAttachArgs(tokens.slice(1));
      if (!chatId || !url) {
        return shellFail(
          "usage: attach <chat-id-or-handle> <url> [--filename <name>] [caption]",
        );
      }
      const media = await mediaFromUrl(url, filename);
      const result = await this.adapterSend(accountId, {
        surface: telegramSurface(chatId),
        text: caption,
        media: [media],
      });
      return result.ok ? shellOk(`sent ${result.messageId ?? ""}`.trim()) : shellFail(result.error);
    }

    return shellFail(`unknown command: ${command}`);
  }

  async start(
    accountId: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const botToken =
      (typeof config.botToken === "string" ? config.botToken : undefined) ||
      this.env.TELEGRAM_BOT_TOKEN;
    const webhookBaseUrl =
      (typeof config.webhookBaseUrl === "string"
        ? config.webhookBaseUrl
        : undefined) || this.env.TELEGRAM_WEBHOOK_BASE_URL;
    const webhookSecret =
      (typeof config.webhookSecret === "string" ? config.webhookSecret : undefined) ||
      this.env.TELEGRAM_WEBHOOK_SECRET;

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
      return await this.withManagedAdmission(`start:${accountId}`, async () => {
        const account = this.getAccountDO(accountId);
        await account.start(botToken, accountId, webhookBaseUrl, webhookSecret);
        return { ok: true };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stop(accountId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      return await this.withManagedAdmission(`stop:${accountId}`, async () => {
        const account = this.getAccountDO(accountId);
        await account.stop();
        return { ok: true };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(accountId?: string): Promise<AdapterAccountStatus[]> {
    if (!accountId) {
      // Account listing is not tracked yet.
      return [];
    }

    try {
      const account = this.getAccountDO(accountId);
      return [await account.getStatus()];
    } catch (error) {
      return [
        {
          accountId,
          connected: false,
          authenticated: false,
          mode: "webhook",
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }

  async send(accountId: string, message: AdapterOutboundMessage): Promise<AdapterSendResult> {
    try {
      return await this.withManagedAdmission(`send:${accountId}`, async () => {
        const account = this.getAccountDO(accountId);
        const result = await account.sendMessage(message);
        if (!result.ok) {
          return { ok: false, error: result.error || "Failed to send Telegram message" };
        }
        return { ok: true, messageId: result.messageId };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setTyping(accountId: string, surface: AdapterSurface, typing: boolean): Promise<void> {
    try {
      await this.withManagedAdmission(`typing:${accountId}`, () =>
        this.getAccountDO(accountId).setTyping(surface, typing),
      );
    } catch (error) {
      if (error instanceof ManagedAdmissionUnavailableError) throw error;
      console.warn(`[TelegramChannel] setTyping failed for ${accountId}:`, error);
    }
  }

  private getAccountDO(accountId: string) {
    const normalized = normalizeAdapterAccountId(accountId);
    if (!normalized) throw new TypeError("Telegram account ID is invalid");
    const id = this.env.TELEGRAM_ACCOUNT.idFromName(normalized);
    return this.env.TELEGRAM_ACCOUNT.get(id);
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

export async function handleTelegramRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/health") {
    return Response.json({
      service: "gsv-channel-telegram",
      status: "ok",
      hasBotToken: !!env.TELEGRAM_BOT_TOKEN,
      hasWebhookBaseUrl: !!env.TELEGRAM_WEBHOOK_BASE_URL,
    });
  }

  const accountId = normalizeAdapterAccountId(accountFromPath(url.pathname));
  if (!accountId) {
    await request.body?.cancel("Telegram route was not found").catch(() => {});
    return new Response("Not Found", { status: 404 });
  }

  const id = env.TELEGRAM_ACCOUNT.idFromName(accountId);
  return runWithManagedAdmission(env.MANAGED_ADMISSION, `webhook:${accountId}`, () =>
    handleTelegramWebhookRequest(request, env.TELEGRAM_ACCOUNT.get(id)),
  ).catch(async (error) => {
    await request.body?.cancel("Telegram webhook admission was rejected").catch(() => {});
    return new Response(
      error instanceof Error ? error.message : "Telegram webhook admission was rejected",
      { status: 503 },
    );
  });
}

export default {
  fetch: handleTelegramRequest,
};

function telegramSurface(id: string): AdapterSurface {
  const trimmed = id.trim();
  if (trimmed.startsWith("@")) {
    return { kind: "channel", id: trimmed, handle: trimmed };
  }
  if (/^\d+$/.test(trimmed)) {
    return { kind: "dm", id: trimmed };
  }
  return { kind: "group", id: trimmed };
}

async function mediaFromUrl(url: string, filename?: string): Promise<AdapterMedia> {
  const mimeType = inferMediaMimeType(url, filename);

  return {
    type: mediaTypeFromMime(mimeType),
    mimeType,
    url,
    ...(filename ? { filename } : {}),
  };
}

function mediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
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
