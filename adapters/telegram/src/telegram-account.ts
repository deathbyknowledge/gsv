import { DurableObject } from "cloudflare:workers";
import {
  classifyNonIdempotentProviderStatus,
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import {
  adapterInboundResultDisposition,
  InboundDeliveryLedger,
} from "../../shared/src/inbound-delivery";
import type { RenderedAdapterSend } from "../../shared/src/peer-render";
import { runAdapterHilSqlMigrations } from "../../shared/src/schema/migrations";
import { callAdapterGateway } from "../../shared/src/gateway-rpc";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import {
  assertAdapterAccountDurableObjectIdentity,
  LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID,
  resolveAdapterAccountDurableObjectIdentity,
} from "../../shared/src/installation";
import {
  cancelResponseBody,
  cancelBinaryBody,
  readAdapterMediaBody,
  responseBodyToBinaryBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  validateAdapterMediaBody,
} from "../../shared/src/media-body";
import type {
  AdapterAccountStatus,
  AdapterActor,
  AdapterInboundMessage,
  AdapterInstallationContext,
  AdapterOutboundMessage,
  AdapterDeliveryContext,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
} from "./types";
import {
  sendTelegramMarkdownMessage,
  type TelegramTextMessageOptions,
} from "./telegram-formatting";
import {
  attachTelegramApprovalMessage,
  handleTelegramApprovalCallback,
  prepareTelegramApproval,
  type TelegramApprovalCallback,
} from "./telegram-approval";
import { planTelegramMediaDeliveries } from "./telegram-media";
import {
  sendTelegramMediaGroupMessage,
  sendTelegramMediaMessage,
} from "./telegram-outbound-media";
import {
  extractTelegramInboundContent,
  loadTelegramInboundMedia,
  type TelegramInboundMediaSource,
} from "./telegram-inbound-media";
import {
  buildTelegramWebhookPath,
  reconcileTelegramApprovalWebhook,
  telegramWebhookRegistration,
  TELEGRAM_APPROVAL_WEBHOOK_VERSION,
} from "./webhook-route";
import type { callManagedTelegramApi } from "./managed-telegram-api";
import * as z from "zod/mini";

interface Env {
  GATEWAY: Fetcher & AdapterGatewayBinding;
}

type TelegramApiSuccess<T> = {
  ok: true;
  result: T;
};

type TelegramApiFailure = {
  ok: false;
  description?: string;
  error_code?: number;
};

type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
    readonly telegramStatus?: number,
    readonly telegramDescription?: string,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

type TelegramChatType = "private" | "group" | "supergroup" | "channel";

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessageEntity = {
  type: string;
  offset: number;
  length: number;
};

type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: {
    message_id: number;
    text?: string;
    caption?: string;
    from?: TelegramUser;
  };
  photo?: TelegramPhotoSize[];
  document?: TelegramFileAttachment;
  audio?: TelegramFileAttachment;
  voice?: TelegramFileAttachment;
  video?: TelegramFileAttachment;
  video_note?: TelegramFileAttachment;
  animation?: TelegramFileAttachment;
  sticker?: TelegramStickerAttachment;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: {
    message_id: number;
    chat: TelegramChat;
  };
  data?: string;
};

type TelegramWebhookInfo = {
  url: string;
  pending_update_count: number;
};

type TelegramPhotoSize = {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramFileAttachment = {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
};

type TelegramStickerAttachment = TelegramFileAttachment & {
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
};

const telegramUserSchema = z.object({
  id: z.number(),
  is_bot: z.optional(z.boolean()),
  first_name: z.optional(z.string()),
  last_name: z.optional(z.string()),
  username: z.optional(z.string()),
});
const telegramChatSchema = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.optional(z.string()),
  username: z.optional(z.string()),
  first_name: z.optional(z.string()),
  last_name: z.optional(z.string()),
});
const telegramMessageEntitySchema = z.object({
  type: z.string(),
  offset: z.number(),
  length: z.number(),
});
const telegramPhotoSizeSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.optional(z.string()),
  width: z.optional(z.number()),
  height: z.optional(z.number()),
  file_size: z.optional(z.number()),
});
const telegramFileAttachmentSchema = z.object({
  file_id: z.optional(z.string()),
  file_unique_id: z.optional(z.string()),
  file_name: z.optional(z.string()),
  mime_type: z.optional(z.string()),
  file_size: z.optional(z.number()),
  duration: z.optional(z.number()),
});
const telegramFileAttachmentFields = {
  file_id: z.optional(z.string()),
  file_unique_id: z.optional(z.string()),
  file_name: z.optional(z.string()),
  mime_type: z.optional(z.string()),
  file_size: z.optional(z.number()),
  duration: z.optional(z.number()),
};
const telegramStickerAttachmentSchema = z.object({
  ...telegramFileAttachmentFields,
  is_animated: z.optional(z.boolean()),
  is_video: z.optional(z.boolean()),
  emoji: z.optional(z.string()),
});
const telegramReplyMessageSchema = z.object({
  message_id: z.number(),
  text: z.optional(z.string()),
  caption: z.optional(z.string()),
  from: z.optional(telegramUserSchema),
});
const telegramMessageSchema = z.object({
  message_id: z.number(),
  date: z.number(),
  chat: telegramChatSchema,
  from: z.optional(telegramUserSchema),
  text: z.optional(z.string()),
  caption: z.optional(z.string()),
  entities: z.optional(z.array(telegramMessageEntitySchema)),
  caption_entities: z.optional(z.array(telegramMessageEntitySchema)),
  reply_to_message: z.optional(telegramReplyMessageSchema),
  photo: z.optional(z.array(telegramPhotoSizeSchema)),
  document: z.optional(telegramFileAttachmentSchema),
  audio: z.optional(telegramFileAttachmentSchema),
  voice: z.optional(telegramFileAttachmentSchema),
  video: z.optional(telegramFileAttachmentSchema),
  video_note: z.optional(telegramFileAttachmentSchema),
  animation: z.optional(telegramFileAttachmentSchema),
  sticker: z.optional(telegramStickerAttachmentSchema),
});
const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  from: telegramUserSchema,
  message: z.optional(z.object({
    message_id: z.number(),
    chat: telegramChatSchema,
  })),
  data: z.optional(z.string()),
});
export const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z.optional(telegramMessageSchema),
  edited_message: z.optional(telegramMessageSchema),
  channel_post: z.optional(telegramMessageSchema),
  edited_channel_post: z.optional(telegramMessageSchema),
  callback_query: z.optional(telegramCallbackQuerySchema),
});

type TelegramFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

type TelegramInboundTransfer = {
  message: AdapterInboundMessage;
  body?: BinaryBody;
};

type TelegramAccountState = {
  installationId: string | null;
  accountId: string;
  botToken: string | null;
  botUserId: number | null;
  botUsername: string | null;
  connected: boolean;
  authenticated: boolean;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookUpdatesVersion: number;
  lastActivity: number | null;
  lastError: string | null;
};

type LegacyTelegramPendingUpdate = {
  updateId: number;
  message: TelegramMessage;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file";
const MAX_MEDIA_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_PART_BYTES;
const MAX_MEDIA_TOTAL_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES;
const INBOUND_DELIVERY_PREFIX = "pending_inbound:";
const INBOUND_WAKE_DELAY_MS = 1_000;
const INBOUND_RETRY_DELAY_MS = 10_000;
const INBOUND_RETRY_BATCH_SIZE = 100;
const LEGACY_PENDING_UPDATE_PREFIX = "pending_update:";
const LEGACY_PROCESSED_UPDATE_PREFIX = "processed_update:";

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildWebhookSecret(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function toErrorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

export class TelegramAccount extends DurableObject<Env> {
  private loaded = false;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<TelegramMessage | TelegramApprovalCallback>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    runAdapterHilSqlMigrations(ctx.storage);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_DELIVERY_PREFIX,
    );
  }

  private state: TelegramAccountState = {
    installationId: null,
    accountId: "default",
    botToken: null,
    botUserId: null,
    botUsername: null,
    connected: false,
    authenticated: false,
    webhookUrl: null,
    webhookSecret: null,
    webhookUpdatesVersion: 0,
    lastActivity: null,
    lastError: null,
  };

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const stored = await this.ctx.storage.get<
      Omit<TelegramAccountState, "installationId"> & {
        installationId?: string | null;
        lastUpdateId?: number | null;
      }
    >("state");
    if (stored) {
      const normalized = { ...stored };
      const hadLegacyUpdateId = "lastUpdateId" in normalized;
      const hadLegacyInstallationId = !("installationId" in normalized);
      delete normalized.lastUpdateId;
      this.state = {
        ...this.state,
        ...normalized,
        installationId: hadLegacyInstallationId
          ? LEGACY_STANDALONE_ADAPTER_INSTALLATION_ID
          : normalized.installationId ?? null,
      };
      if (hadLegacyUpdateId || hadLegacyInstallationId) {
        await this.saveState();
      }
    }

    await this.migrateLegacyInboundUpdates();
    this.loaded = true;
  }

  private async migrateLegacyInboundUpdates(): Promise<void> {
    const pending = await this.ctx.storage.list<LegacyTelegramPendingUpdate>({
      prefix: LEGACY_PENDING_UPDATE_PREFIX,
    });
    const updates = [...pending.entries()]
      .sort(([, left], [, right]) => left.updateId - right.updateId);
    for (const [, update] of updates) {
      await this.inboundDeliveries.enqueueAndArm(
        String(update.updateId),
        update.message,
        Date.now() + INBOUND_WAKE_DELAY_MS,
      );
    }
    if (updates.length > 0) {
      await this.ctx.storage.delete(updates.map(([key]) => key));
    }

    const processed = await this.ctx.storage.list({
      prefix: LEGACY_PROCESSED_UPDATE_PREFIX,
    });
    if (processed.size > 0) {
      await this.ctx.storage.delete([...processed.keys()]);
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private async commitLifecycleState(alarmAt: number | null): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put("state", this.state);
      if (alarmAt === null) {
        await txn.deleteAlarm();
      } else {
        await txn.setAlarm(alarmAt);
      }
    });
  }

  private getAccountId(): string {
    return this.state.accountId || "default";
  }

  private getInstallationContext(): AdapterInstallationContext {
    const identity = resolveAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      this.state,
    );
    return { installationId: identity.installationId };
  }

  private async callTelegramApi<T>(
    method: string,
    payload: Parameters<typeof callManagedTelegramApi>[2],
    botToken?: string,
  ): Promise<T> {
    const token = botToken ?? this.state.botToken;
    if (!token) {
      throw new Error("Telegram bot token is not configured");
    }

    const isFormDataPayload = payload instanceof FormData;

    let response: Response;
    try {
      response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: isFormDataPayload
          ? undefined
          : {
              "Content-Type": "application/json; charset=utf-8",
            },
        body: isFormDataPayload ? payload : JSON.stringify(payload),
      });
    } catch (error) {
      throw new TelegramDeliveryError(
        `Telegram API ${method} transport failed: ${toErrorMessage(error instanceof Error ? error : String(error))}`,
        "ambiguous",
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new TelegramDeliveryError(
        `Telegram API ${method} response could not be read: ${toErrorMessage(error instanceof Error ? error : String(error))}`,
        response.ok
          ? "ambiguous"
          : classifyNonIdempotentProviderStatus(response.status),
      );
    }
    let parsed: TelegramApiResponse<T> | null = null;
    if (responseText) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const details = parsed && !parsed.ok ? parsed.description : responseText;
      const description = details || response.statusText;
      throw new TelegramDeliveryError(
        `Telegram API ${method} failed (${response.status}): ${description}`,
        classifyNonIdempotentProviderStatus(response.status),
        response.status,
        description,
      );
    }

    if (!parsed) {
      throw new TelegramDeliveryError(
        `Telegram API ${method} returned an empty or invalid response`,
        "ambiguous",
      );
    }

    if (!parsed.ok) {
      const code = parsed.error_code ? ` ${parsed.error_code}` : "";
      const status = parsed.error_code ?? response.status;
      const description = parsed.description || "Unknown error";
      throw new TelegramDeliveryError(
        `Telegram API ${method} error${code}: ${description}`,
        classifyNonIdempotentProviderStatus(status),
        status,
        description,
      );
    }

    return parsed.result;
  }

  async start(
    botToken: string,
    accountId: string,
    webhookBaseUrl: string,
    webhookRoute: string,
    providedSecret?: string,
  ): Promise<void> {
    await this.ensureLoaded();

    const normalizedToken = botToken.trim();
    if (!normalizedToken) {
      throw new Error("Bot token is required");
    }

    const baseUrl = trimTrailingSlashes(webhookBaseUrl.trim());
    if (!baseUrl.startsWith("https://")) {
      throw new Error("webhook base URL must be an https URL");
    }

    const normalizedAccountId = accountId.trim() || "default";
    const accountIdentity = assertAdapterAccountDurableObjectIdentity(
      this.ctx.id.name,
      normalizedAccountId,
      this.state,
    );
    if (
      this.state.installationId
      && this.state.installationId !== accountIdentity.installationId
    ) {
      throw new Error("Adapter installation identity mismatch");
    }
    const identityChanged =
      this.state.installationId !== accountIdentity.installationId
      || this.state.accountId !== accountIdentity.accountId;
    this.state.installationId = accountIdentity.installationId;
    this.state.accountId = accountIdentity.accountId;
    if (identityChanged) {
      await this.saveState();
    }
    const normalizedWebhookRoute = webhookRoute.trim();
    if (!normalizedWebhookRoute) {
      throw new Error("Webhook route is required");
    }
    const webhookSecret =
      (providedSecret && providedSecret.trim()) ||
      this.state.webhookSecret ||
      buildWebhookSecret();
    const webhookUrl = `${baseUrl}${buildTelegramWebhookPath(
      accountIdentity.installationId,
      normalizedWebhookRoute,
    )}`;

    const me = await this.callTelegramApi<TelegramUser>(
      "getMe",
      {},
      normalizedToken,
    );

    await this.callTelegramApi<boolean>(
      "setWebhook",
      telegramWebhookRegistration(webhookUrl, webhookSecret),
      normalizedToken,
    );

    this.state.accountId = normalizedAccountId;
    this.state.botToken = normalizedToken;
    this.state.botUserId = me.id;
    this.state.botUsername = me.username || null;
    this.state.connected = true;
    this.state.authenticated = true;
    this.state.webhookUrl = webhookUrl;
    this.state.webhookSecret = webhookSecret;
    this.state.webhookUpdatesVersion = TELEGRAM_APPROVAL_WEBHOOK_VERSION;
    this.state.lastError = null;

    await this.commitLifecycleState(Date.now() + INBOUND_WAKE_DELAY_MS);
    await this.notifyGatewayStatus();
  }

  async stop(): Promise<void> {
    await this.ensureLoaded();

    if (this.state.botToken) {
      try {
        await this.callTelegramApi<boolean>("deleteWebhook", {
          drop_pending_updates: false,
        });
      } catch (error) {
        console.warn(
          `[TelegramAccount:${this.getAccountId()}] deleteWebhook failed:`,
          error,
        );
      }
    }

    this.state.connected = false;
    this.state.authenticated = false;
    this.state.lastError = null;
    await this.commitLifecycleState(null);
    await this.notifyGatewayStatus();
  }

  async getStatus(): Promise<AdapterAccountStatus> {
    await this.ensureLoaded();

    let pendingUpdateCount: number | undefined;
    if (this.state.botToken) {
      try {
        const info = await this.callTelegramApi<TelegramWebhookInfo>(
          "getWebhookInfo",
          {},
        );
        pendingUpdateCount = info.pending_update_count;
      } catch {
        // Best effort only.
      }
    }

    const extra: NonNullable<AdapterAccountStatus["extra"]> = {};
    if (this.state.botUserId !== null) extra.botUserId = this.state.botUserId;
    if (this.state.botUsername !== null) extra.botUsername = this.state.botUsername;
    if (this.state.webhookUrl !== null) extra.webhookUrl = this.state.webhookUrl;
    if (pendingUpdateCount !== undefined) extra.pendingUpdateCount = pendingUpdateCount;

    return {
      accountId: this.getAccountId(),
      connected: this.state.connected,
      authenticated: this.state.authenticated,
      mode: "webhook",
      lastActivity: this.state.lastActivity ?? undefined,
      error: this.state.lastError ?? undefined,
      extra,
    };
  }

  async sendMessage(
    message: AdapterOutboundMessage,
    body?: BinaryBody,
    options: TelegramTextMessageOptions = {},
  ): Promise<AdapterSendResult> {
    await this.ensureLoaded();

    if (!this.state.botToken || !this.state.authenticated) {
      await cancelBinaryBody(body, "Telegram account is not authenticated");
      return { ok: false, error: "Telegram account is not authenticated" };
    }

    const trimmedText = message.text.trim();
    const media = message.media ?? [];

    if (!trimmedText && media.length === 0) {
      await cancelBinaryBody(body, "Telegram requires text or media");
      return { ok: false, error: "Telegram requires text or media" };
    }
    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: toErrorMessage(error instanceof Error ? error : String(error)) };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    let acceptedMediaDeliveries = 0;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Could not read Telegram media body: ${toErrorMessage(error instanceof Error ? error : String(error))}`,
        retryable: true,
      };
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintOutboundDelivery(
        telegramFingerprintMessage(message, options),
        mediaBytes,
      );
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint Telegram delivery: ${toErrorMessage(error instanceof Error ? error : String(error))}`,
        retryable: true,
      };
    }

    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, requestFingerprint);
    } catch (error) {
      return {
        ok: false,
        error: `Telegram delivery ledger unavailable: ${toErrorMessage(error instanceof Error ? error : String(error))}`,
        retryable: true,
      };
    }
    if (!claim.claimed) {
      return claim.result;
    }

    const { attemptId } = claim;
    const fail = async (
      kind: DeliveryFailureKind,
      error: string,
    ): Promise<AdapterSendResult> => {
      try {
        if (kind === "retryable") {
          await this.deliveries.releaseRetryable(message.deliveryId, attemptId);
        } else if (kind === "ambiguous") {
          await this.deliveries.failAmbiguous(message.deliveryId, attemptId, error);
        } else {
          await this.deliveries.failPermanent(message.deliveryId, attemptId, error);
        }
      } catch (ledgerError) {
        console.error(
          `[TelegramAccount:${this.getAccountId()}] Failed to persist delivery outcome`,
          ledgerError,
        );
      }
      this.state.lastError = error;
      try {
        await this.saveState();
      } catch (stateError) {
        console.error(
          `[TelegramAccount:${this.getAccountId()}] Failed to persist adapter error`,
          stateError,
        );
      }
      return {
        ok: false,
        error,
        retryable: kind === "retryable" ? true : undefined,
        ambiguous: kind === "ambiguous" ? true : undefined,
      };
    };

    try {
      const replyToMessageId = message.replyToId
        ? Number.parseInt(message.replyToId, 10)
        : undefined;
      let sentMessageId: string | undefined;

      if (media.length === 0) {
        const sent = await this.sendFormattedTextMessage(
          message.surface.id,
          trimmedText,
          replyToMessageId,
          options,
        );
        sentMessageId = String(sent.message_id);
      } else {
        const deliveries = planTelegramMediaDeliveries(media);
        let mediaOffset = 0;
          const callApi = <T>(method: string, payload: Parameters<typeof callManagedTelegramApi>[2]) =>
          this.callTelegramApi<T>(method, payload);
        for (const [index, delivery] of deliveries.entries()) {
          const caption = index === 0 ? trimmedText : "";
          const deliveryBytes = mediaBytes.slice(
            mediaOffset,
            mediaOffset + delivery.length,
          );
          const firstSentMessage = delivery.length === 1
            ? await sendTelegramMediaMessage(
                callApi,
                message.surface.id,
                delivery[0],
                deliveryBytes[0],
                caption,
                replyToMessageId,
              )
            : (await sendTelegramMediaGroupMessage(
                callApi,
                message.surface.id,
                delivery,
                deliveryBytes,
                caption,
                replyToMessageId,
              ))[0];

          acceptedMediaDeliveries += 1;
          mediaOffset += delivery.length;
          if (!sentMessageId && firstSentMessage) {
            sentMessageId = String(firstSentMessage.message_id);
          }
        }
      }

      try {
        await this.deliveries.succeed(message.deliveryId, attemptId, sentMessageId);
      } catch {
        return {
          ok: false,
          error: "Telegram accepted the delivery but its durable outcome could not be recorded",
          ambiguous: true,
        };
      }

      this.state.lastActivity = Date.now();
      this.state.lastError = null;
      try {
        await this.saveState();
      } catch (error) {
        console.error(
          `[TelegramAccount:${this.getAccountId()}] Failed to persist send activity`,
          error,
        );
      }
      return { ok: true, messageId: sentMessageId };
    } catch (error) {
      const kind = acceptedMediaDeliveries > 0
        ? "ambiguous"
        : error instanceof TelegramDeliveryError
          ? error.kind
          : "permanent";
      return await fail(kind, toErrorMessage(error instanceof Error ? error : String(error)));
    }
  }

  private sendFormattedTextMessage(
    chatId: string,
    text: string,
    replyToMessageId?: number,
    options: TelegramTextMessageOptions = {},
  ): Promise<TelegramMessage> {
    return sendTelegramMarkdownMessage(
      (method, payload) =>
        this.callTelegramApi<TelegramMessage>(method, payload),
      chatId,
      text,
      replyToMessageId,
      options,
    );
  }

  async setTyping(surface: AdapterSurface, typing: boolean): Promise<void> {
    await this.ensureLoaded();

    if (!typing || !this.state.botToken || !this.state.authenticated) {
      return;
    }

    try {
      await this.callTelegramApi<boolean>("sendChatAction", {
        chat_id: surface.id,
        action: "typing",
      });
    } catch (error) {
      console.warn(
        `[TelegramAccount:${this.getAccountId()}] setTyping failed:`,
        error,
      );
    }
  }

  async sendRoutedMessage(
    context: AdapterDeliveryContext,
    delivery: RenderedAdapterSend,
    body?: BinaryBody,
  ): Promise<AdapterSendResult> {
    if (!delivery.hil) {
      return await this.sendMessage(delivery.message, body);
    }
    const controls = await prepareTelegramApproval(
      this.ctx.storage,
      context,
      delivery.hil,
    );
    if (controls) await this.ensureApprovalWebhook();
    const result = await this.sendMessage(
      delivery.message,
      body,
      controls ? { replyMarkup: controls.replyMarkup } : {},
    );
    if (result.ok && controls) {
      await attachTelegramApprovalMessage(
        this.ctx.storage,
        controls.token,
        result.messageId,
      );
    }
    return result;
  }

  private async ensureApprovalWebhook(): Promise<void> {
    await this.ensureLoaded();
    if (!this.state.botToken) throw new Error("Telegram approval webhook is not initialized");
    const nextVersion = await reconcileTelegramApprovalWebhook(
      this.state.webhookUpdatesVersion,
      this.state.webhookUrl,
      this.state.webhookSecret,
      async (registration) => {
        await this.callTelegramApi<boolean>("setWebhook", registration);
      },
    );
    if (nextVersion === this.state.webhookUpdatesVersion) return;
    this.state.webhookUpdatesVersion = nextVersion;
    await this.saveState();
  }

  async handleWebhook(
    update: TelegramUpdate,
    secretToken: string | null,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    await this.ensureLoaded();

    if (!this.state.webhookSecret) {
      return {
        ok: false,
        status: 409,
        error: "Telegram account webhook is not initialized",
      };
    }

    if (!secretToken || secretToken !== this.state.webhookSecret) {
      return {
        ok: false,
        status: 401,
        error: "Invalid webhook secret token",
      };
    }

    const updateId = this.normalizeUpdateId(update.update_id);
    const callback = this.extractApprovalCallback(update);
    if (callback) {
      const deliveryId = `callback:${callback.callbackQueryId}`;
      await this.inboundDeliveries.enqueueAndArm(
        deliveryId,
        callback,
        Date.now() + INBOUND_WAKE_DELAY_MS,
      );
      if (this.canProcessInbound()) {
        this.ctx.waitUntil(this.deliverPendingInbound(deliveryId));
      }
      return { ok: true };
    }

    const message = this.extractMessage(update);
    if (!message) {
      return { ok: true };
    }

    const deliveryId = updateId === null
      ? `message:${message.chat.id}:${message.message_id}`
      : String(updateId);
    await this.inboundDeliveries.enqueueAndArm(
      deliveryId,
      message,
      Date.now() + INBOUND_WAKE_DELAY_MS,
    );
    if (!this.canProcessInbound()) {
      return { ok: true };
    }

    if (updateId === null) {
      const attempt = await this.deliverPendingInbound(deliveryId);
      if (attempt === "pending") {
        return {
          ok: false,
          status: 502,
          error: this.state.lastError ?? "Failed to process Telegram update",
        };
      }
    }

    return { ok: true };
  }

  private async forwardWebhookMessage(
    message: TelegramMessage,
    deliveryId: string,
  ): Promise<{ terminal: boolean; error?: string }> {
    if (!this.canProcessInbound()) {
      return { terminal: false, error: "Telegram account is disconnected" };
    }

    const inbound = await this.toInboundMessage(message);
    if (!inbound) {
      return { terminal: true };
    }

    if (!this.canProcessInbound()) {
      await cancelBinaryBody(inbound.body, "Telegram account stopped before delivery");
      return { terminal: false, error: "Telegram account is disconnected" };
    }

    const result = await callAdapterGateway(
      this.env.GATEWAY,
      this.getInstallationContext(),
      "adapter.inbound",
      {
        adapter: "telegram",
        accountId: this.getAccountId(),
        deliveryId,
        message: inbound.message,
      },
      inbound.body,
    );
    const responseDisposition = adapterInboundResultDisposition(result, {
      surface: inbound.message.surface,
      providerMessageId: inbound.message.messageId,
    });
    if (!responseDisposition.terminal) return responseDisposition;
    if (!result.ok) {
      this.state.lastError = result.error || "Gateway rejected inbound message";
      await this.saveState();
      return responseDisposition;
    }

    this.state.lastActivity = Date.now();
    this.state.lastError = null;
    await this.saveState();
    return responseDisposition;
  }

  private async forwardWebhookEvent(
    event: TelegramMessage | TelegramApprovalCallback,
    deliveryId: string,
  ): Promise<{ terminal: boolean; error?: string }> {
    if (!("callbackQueryId" in event)) {
      return await this.forwardWebhookMessage(event, deliveryId);
    }
    await handleTelegramApprovalCallback(
      this.ctx.storage,
      this.env.GATEWAY,
      this.getInstallationContext(),
      event,
      {
        answerCallbackQuery: async (callbackQueryId, text) => {
          await this.callTelegramApi<boolean>("answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            text,
          });
        },
        clearInlineKeyboard: async (surfaceId, providerMessageId) => {
          await this.callTelegramApi<TelegramMessage>("editMessageReplyMarkup", {
            chat_id: surfaceId,
            message_id: Number.parseInt(providerMessageId, 10),
            reply_markup: { inline_keyboard: [] },
          });
        },
      },
    );
    return { terminal: true };
  }

  private normalizeUpdateId(value: number | null | undefined): number | null {
    if (value === undefined || value === null || !Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return value;
  }

  private canProcessInbound(): boolean {
    return Boolean(
      this.state.connected && this.state.authenticated && this.state.botToken,
    );
  }

  private async deliverPendingInbound(
    deliveryId: string,
  ): Promise<"completed" | "pending"> {
    const attempt = await this.inboundDeliveries.attempt(
      deliveryId,
      async (event) => this.forwardWebhookEvent(event, deliveryId),
      async (response) => this.sendMessage(response),
    );
    if (attempt.state !== "pending") {
      return "completed";
    }

    this.state.lastError = attempt.error ?? "Gateway receipt is still in progress";
    await this.saveState();
    return "pending";
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this.canProcessInbound()) {
      return;
    }

    // Re-arm before provider or Gateway I/O. If this alarm invocation crashes,
    // the durable record still has another scheduled owner.
    await this.inboundDeliveries.armIfPending(
      Date.now() + INBOUND_RETRY_DELAY_MS,
    );
    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const deliveryId of ids) {
      await this.deliverPendingInbound(deliveryId);
    }
  }

  private extractMessage(update: TelegramUpdate): TelegramMessage | null {
    return update.message || update.channel_post || null;
  }

  private extractApprovalCallback(update: TelegramUpdate): TelegramApprovalCallback | null {
    const query = update.callback_query;
    const message = query?.message;
    const data = query?.data;
    if (
      !query
      || !message
      || !data?.startsWith("gsvh:")
      || message.chat.type !== "private"
      || query.from.is_bot
      || query.from.id !== message.chat.id
      || !Number.isSafeInteger(message.message_id)
      || message.message_id <= 0
    ) {
      return null;
    }
    return {
      callbackQueryId: query.id,
      actorId: `telegram:user:${query.from.id}`,
      surfaceId: String(message.chat.id),
      providerMessageId: String(message.message_id),
      data,
    };
  }

  private async toInboundMessage(message: TelegramMessage): Promise<TelegramInboundTransfer | null> {
    if (message.from?.is_bot && message.from.id === this.state.botUserId) {
      return null;
    }

    const content = extractTelegramInboundContent(message, String(message.message_id));
    if (!content.text) {
      return null;
    }

    const actor = this.toActor(message.from) ?? this.toChatActor(message.chat);
    const surfaceKind = this.mapSurfaceKind(message.chat.type);
    const surfaceName = this.getChatDisplayName(message.chat);

    const wasMentioned = this.computeWasMentioned(message, content.text);
    const media = await this.extractMediaAttachments(content.media);

    return {
      message: {
        messageId: String(message.message_id),
        surface: {
          kind: surfaceKind,
          id: String(message.chat.id),
          name: surfaceName,
          handle: message.chat.username ? `@${message.chat.username}` : undefined,
        },
        actor,
        text: content.text,
        replyToId: message.reply_to_message
          ? String(message.reply_to_message.message_id)
          : undefined,
        replyToText:
          message.reply_to_message?.text ||
          message.reply_to_message?.caption ||
          undefined,
        timestamp: message.date * 1000,
        wasMentioned,
        media: media.media.length > 0 ? media.media : undefined,
      },
      body: media.body,
    };
  }

  private async extractMediaAttachments(
    sources: readonly TelegramInboundMediaSource[],
  ) {
    return await loadTelegramInboundMedia(sources, {
      getFile: async (fileId) => await this.callTelegramApi<TelegramFile>("getFile", {
        file_id: fileId,
      }),
      downloadFile: async (filePath, expectedSize, maxBytes) =>
        await this.downloadTelegramFile(filePath, expectedSize, maxBytes),
      skipFailures: true,
      onFailure: (error) => {
        console.warn(`[TelegramAccount:${this.getAccountId()}] Failed to download media`, error);
      },
    });
  }

  private async downloadTelegramFile(
    filePath: string,
    expectedSize: number | undefined,
    maxBytes: number,
  ): Promise<(BinaryBody & { length: number }) | null> {
    if (!this.state.botToken) {
      return null;
    }

    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${TELEGRAM_FILE_BASE}/bot${this.state.botToken}/${encodedPath}`,
    );
    if (!response.ok) {
      await cancelResponseBody(response, "Telegram media download failed");
      console.warn(
        `[TelegramAccount:${this.getAccountId()}] Telegram file download failed: HTTP ${response.status}`,
      );
      return null;
    }

    return await responseBodyToBinaryBody(response, {
      maxBytes,
      expectedBytes: expectedSize,
      label: "Telegram media",
    });
  }

  private mapSurfaceKind(chatType: TelegramChatType): "dm" | "group" | "channel" {
    if (chatType === "private") return "dm";
    if (chatType === "channel") return "channel";
    return "group";
  }

  private getChatDisplayName(chat: TelegramChat): string | undefined {
    if (chat.title) return chat.title;

    const first = chat.first_name || "";
    const last = chat.last_name || "";
    const full = `${first} ${last}`.trim();
    if (full) return full;

    if (chat.username) return `@${chat.username}`;
    return undefined;
  }

  private toActor(user?: TelegramUser): AdapterActor | undefined {
    if (!user) return undefined;

    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

    return {
      id: `telegram:user:${user.id}`,
      name: name || undefined,
      handle: user.username ? `@${user.username}` : undefined,
    };
  }

  private toChatActor(chat: TelegramChat): AdapterActor {
    return {
      id: `telegram:chat:${chat.id}`,
      name: this.getChatDisplayName(chat),
      handle: chat.username ? `@${chat.username}` : undefined,
    };
  }

  private computeWasMentioned(message: TelegramMessage, text: string): boolean {
    if (message.chat.type === "private") {
      return true;
    }

    if (
      message.reply_to_message?.from?.id &&
      this.state.botUserId &&
      message.reply_to_message.from.id === this.state.botUserId
    ) {
      return true;
    }

    if (!this.state.botUsername) {
      return false;
    }

    const mention = `@${this.state.botUsername.toLowerCase()}`;
    if (text.toLowerCase().includes(mention)) {
      return true;
    }

    const entities = [...(message.entities || []), ...(message.caption_entities || [])];
    for (const entity of entities) {
      if (entity.type !== "mention") continue;

      const mentionText = text.slice(
        entity.offset,
        entity.offset + entity.length,
      );
      if (mentionText.toLowerCase() === mention) {
        return true;
      }
    }

    return false;
  }

  private async notifyGatewayStatus(): Promise<void> {
    try {
      const installation = this.getInstallationContext();
      const status = await this.getStatus();
      await callAdapterGateway(
        this.env.GATEWAY,
        installation,
        "adapter.state.update",
        {
          adapter: "telegram",
          accountId: this.getAccountId(),
          status,
        },
      );
    } catch (error) {
      console.error(
        `[TelegramAccount:${this.getAccountId()}] Failed to notify status:`,
        error,
      );
    }
  }
}

function telegramFingerprintMessage(
  message: AdapterOutboundMessage,
  options: TelegramTextMessageOptions,
): AdapterOutboundMessage {
  if (!options.replyMarkup) return message;
  return {
    ...message,
    text: `${message.text}\n\n[gsv-telegram-controls:${JSON.stringify(options.replyMarkup)}]`,
  };
}
