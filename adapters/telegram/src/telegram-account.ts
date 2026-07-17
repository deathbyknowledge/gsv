import { DurableObject } from "cloudflare:workers";
import {
  classifyNonIdempotentProviderStatus,
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import type { DeliveryFailureKind } from "../../shared/src/delivery-ledger";
import {
  InboundDeliveryLedger,
  isTerminalAdapterInboundResult,
} from "../../shared/src/inbound-delivery";
import {
  bundleAdapterMedia,
  cancelResponseBody,
  cancelBinaryBody,
  readAdapterMediaBody,
  responseBodyToBinaryBody,
  validateAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
} from "../../shared/src/media-body";
import type {
  AdapterMediaBundle,
  AdapterMediaPart,
} from "../../shared/src/media-body";
import type {
  AdapterAccountStatus,
  AdapterActor,
  AdapterInboundMessage,
  AdapterInboundResult,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  AdapterSurface,
  BinaryBody,
  GatewayFrame,
  GatewayRequestFrame,
} from "./types";
import {
  callTelegramApiWithMarkdownCaption,
  sendTelegramMarkdownMessage,
} from "./telegram-formatting";

type GatewayAdapterBinding = Fetcher & {
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
};

interface Env {
  GATEWAY: GatewayAdapterBinding;
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

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
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

type TelegramFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

type TelegramInboundMediaSource = {
  type: AdapterMedia["type"];
  fileId: string;
  mimeType: string;
  filename?: string;
  size?: number;
  duration?: number;
};

type TelegramInboundTransfer = {
  message: AdapterInboundMessage;
  body?: BinaryBody;
};

type TelegramInputMediaType = "photo" | "video" | "audio" | "document";

type TelegramInputMedia = {
  type: TelegramInputMediaType;
  media: string;
  caption?: string;
  parse_mode?: "HTML";
};

type TelegramAccountState = {
  accountId: string;
  botToken: string | null;
  botUserId: number | null;
  botUsername: string | null;
  connected: boolean;
  authenticated: boolean;
  webhookUrl: string | null;
  webhookSecret: string | null;
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TelegramAccount extends DurableObject<Env> {
  private loaded = false;
  private readonly deliveries: DeliveryLedger;
  private readonly inboundDeliveries: InboundDeliveryLedger<TelegramMessage>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deliveries = new DeliveryLedger(this.ctx.storage);
    this.inboundDeliveries = new InboundDeliveryLedger(
      this.ctx.storage,
      INBOUND_DELIVERY_PREFIX,
    );
  }

  private state: TelegramAccountState = {
    accountId: "default",
    botToken: null,
    botUserId: null,
    botUsername: null,
    connected: false,
    authenticated: false,
    webhookUrl: null,
    webhookSecret: null,
    lastActivity: null,
    lastError: null,
  };

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const stored = await this.ctx.storage.get<
      TelegramAccountState & { lastUpdateId?: number | null }
    >("state");
    if (stored) {
      const normalized = { ...stored };
      const hadLegacyUpdateId = "lastUpdateId" in normalized;
      delete normalized.lastUpdateId;
      this.state = { ...this.state, ...normalized };
      if (hadLegacyUpdateId) {
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
      await this.inboundDeliveries.enqueue(String(update.updateId), update.message);
    }
    if (updates.length > 0) {
      if (this.canProcessInbound()) {
        await this.scheduleInboundRetry(INBOUND_WAKE_DELAY_MS);
      }
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

  private getAccountId(): string {
    return this.state.accountId || "default";
  }

  private async callTelegramApi<T>(
    method: string,
    payload: Record<string, unknown> | FormData,
    botToken?: string,
  ): Promise<T> {
    const token = botToken ?? this.state.botToken;
    if (!token) {
      throw new Error("Telegram bot token is not configured");
    }

    const isFormDataPayload =
      typeof FormData !== "undefined" && payload instanceof FormData;

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
        `Telegram API ${method} transport failed: ${toErrorMessage(error)}`,
        "ambiguous",
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new TelegramDeliveryError(
        `Telegram API ${method} response could not be read: ${toErrorMessage(error)}`,
        response.ok
          ? "ambiguous"
          : classifyNonIdempotentProviderStatus(response.status),
      );
    }
    let parsed: TelegramApiResponse<T> | null = null;
    if (responseText) {
      try {
        parsed = JSON.parse(responseText) as TelegramApiResponse<T>;
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
    const webhookSecret =
      (providedSecret && providedSecret.trim()) ||
      this.state.webhookSecret ||
      buildWebhookSecret();
    const webhookUrl = `${baseUrl}/webhook/${encodeURIComponent(normalizedAccountId)}`;

    const me = await this.callTelegramApi<TelegramUser>(
      "getMe",
      {},
      normalizedToken,
    );

    await this.callTelegramApi<boolean>(
      "setWebhook",
      {
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message", "channel_post"],
      },
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
    this.state.lastError = null;

    await this.saveState();
    if (await this.inboundDeliveries.hasPending()) {
      await this.scheduleInboundRetry(INBOUND_WAKE_DELAY_MS);
    }
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
    await this.ctx.storage.deleteAlarm();
    await this.saveState();
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

    return {
      accountId: this.getAccountId(),
      connected: this.state.connected,
      authenticated: this.state.authenticated,
      mode: "webhook",
      lastActivity: this.state.lastActivity ?? undefined,
      error: this.state.lastError ?? undefined,
      extra: {
        botUserId: this.state.botUserId ?? undefined,
        botUsername: this.state.botUsername ?? undefined,
        webhookUrl: this.state.webhookUrl ?? undefined,
        pendingUpdateCount,
      },
    };
  }

  async sendMessage(
    message: AdapterOutboundMessage,
    body?: BinaryBody,
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
    if (media.length > 10) {
      await cancelBinaryBody(body, "Telegram media groups support at most 10 attachments");
      return {
        ok: false,
        error: "Telegram media groups support at most 10 attachments",
      };
    }

    try {
      validateAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      await cancelBinaryBody(body, error);
      return { ok: false, error: toErrorMessage(error) };
    }

    let mediaBytes: Array<Uint8Array | undefined>;
    try {
      mediaBytes = await readAdapterMediaBody(media, body, {
        maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
        maxPartBytes: MAX_MEDIA_BODY_BYTES,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Could not read Telegram media body: ${toErrorMessage(error)}`,
        retryable: true,
      };
    }

    let requestFingerprint: string;
    try {
      requestFingerprint = await fingerprintOutboundDelivery(message, mediaBytes);
    } catch (error) {
      return {
        ok: false,
        error: `Could not fingerprint Telegram delivery: ${toErrorMessage(error)}`,
        retryable: true,
      };
    }

    let claim;
    try {
      claim = await this.deliveries.claim(message.deliveryId, requestFingerprint);
    } catch (error) {
      return {
        ok: false,
        error: `Telegram delivery ledger unavailable: ${toErrorMessage(error)}`,
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
        ...(kind === "retryable" ? { retryable: true } : {}),
        ...(kind === "ambiguous" ? { ambiguous: true } : {}),
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
        );
        sentMessageId = String(sent.message_id);
      } else if (media.length === 1) {
        const sent = await this.sendMediaMessage(
          message.surface.id,
          media[0],
          mediaBytes[0],
          trimmedText,
          replyToMessageId,
        );
        sentMessageId = String(sent.message_id);
      } else {
        const sent = await this.sendMediaGroupMessage(
          message.surface.id,
          media,
          mediaBytes,
          trimmedText,
          replyToMessageId,
        );
        sentMessageId = sent[0] ? String(sent[0].message_id) : undefined;
      }

      try {
        await this.deliveries.succeed(message.deliveryId, attemptId, sentMessageId);
      } catch (error) {
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
      const kind = error instanceof TelegramDeliveryError
        ? error.kind
        : "permanent";
      return await fail(kind, toErrorMessage(error));
    }
  }

  private sendFormattedTextMessage(
    chatId: string,
    text: string,
    replyToMessageId?: number,
  ): Promise<TelegramMessage> {
    return sendTelegramMarkdownMessage(
      (method, payload) =>
        this.callTelegramApi<TelegramMessage>(method, payload),
      chatId,
      text,
      replyToMessageId,
    );
  }

  private async sendMediaMessage(
    chatId: string,
    media: AdapterMedia,
    bytes: Uint8Array | undefined,
    text: string,
    replyToMessageId?: number,
  ): Promise<TelegramMessage> {
    const { method, mediaField } = this.getTelegramSendMethod(media.type);
    const caption = text.trim() || undefined;

    if (media.url) {
      return callTelegramApiWithMarkdownCaption(
        (apiMethod, payload) =>
          this.callTelegramApi<TelegramMessage>(apiMethod, payload),
        method,
        caption,
        (formattedCaption, parseMode) => ({
          chat_id: chatId,
          [mediaField]: media.url,
          ...(formattedCaption ? { caption: formattedCaption } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(Number.isFinite(replyToMessageId)
            ? { reply_to_message_id: replyToMessageId }
            : {}),
        }),
      );
    }

    if (bytes) {
      const filename = this.buildMediaFilename(media);
      const blob = new Blob([bytes], { type: media.mimeType });

      return callTelegramApiWithMarkdownCaption(
        (apiMethod, payload) =>
          this.callTelegramApi<TelegramMessage>(apiMethod, payload),
        method,
        caption,
        (formattedCaption, parseMode) => {
          const form = new FormData();
          form.set("chat_id", chatId);
          if (formattedCaption) {
            form.set("caption", formattedCaption);
          }
          if (parseMode) {
            form.set("parse_mode", parseMode);
          }
          if (Number.isFinite(replyToMessageId)) {
            form.set("reply_to_message_id", String(replyToMessageId));
          }
          form.set(mediaField, blob, filename);
          return form;
        },
      );
    }

    throw new Error(
      "Telegram media attachment must include either a binary body or a URL",
    );
  }

  private async sendMediaGroupMessage(
    chatId: string,
    mediaItems: AdapterMedia[],
    mediaBytes: Array<Uint8Array | undefined>,
    text: string,
    replyToMessageId?: number,
  ): Promise<TelegramMessage[]> {
    if (mediaItems.length < 2) {
      throw new Error(
        "Telegram media groups require at least 2 attachments",
      );
    }

    this.validateMediaGroupTypes(mediaItems);

    const caption = text.trim() || undefined;
    const preparedMedia: Array<Pick<TelegramInputMedia, "type" | "media">> = [];
    const uploadEntries: Array<{ field: string; blob: Blob; filename: string }> = [];

    for (const [index, media] of mediaItems.entries()) {
      const inputType = this.toTelegramInputMediaType(media.type);
      const item: Pick<TelegramInputMedia, "type" | "media"> = {
        type: inputType,
        media: "",
      };

      if (media.url) {
        item.media = media.url;
      } else if (mediaBytes[index]) {
        const field = `file${index + 1}`;
        item.media = `attach://${field}`;
        uploadEntries.push({
          field,
          blob: new Blob([mediaBytes[index]], { type: media.mimeType }),
          filename: this.buildMediaFilename(media),
        });
      } else {
        throw new Error(
          "Telegram media attachment must include either a binary body or a URL",
        );
      }

      preparedMedia.push(item);
    }

    return callTelegramApiWithMarkdownCaption(
      (method, payload) =>
        this.callTelegramApi<TelegramMessage[]>(method, payload),
      "sendMediaGroup",
      caption,
      (formattedCaption, parseMode) => {
        const inputMedia = preparedMedia.map<TelegramInputMedia>((media, index) => ({
          ...media,
          ...(index === 0 && formattedCaption
            ? { caption: formattedCaption }
            : {}),
          ...(index === 0 && parseMode ? { parse_mode: parseMode } : {}),
        }));

        if (uploadEntries.length === 0) {
          return {
            chat_id: chatId,
            media: inputMedia,
            ...(Number.isFinite(replyToMessageId)
              ? { reply_to_message_id: replyToMessageId }
              : {}),
          };
        }

        const form = new FormData();
        form.set("chat_id", chatId);
        form.set("media", JSON.stringify(inputMedia));
        if (Number.isFinite(replyToMessageId)) {
          form.set("reply_to_message_id", String(replyToMessageId));
        }
        for (const upload of uploadEntries) {
          form.set(upload.field, upload.blob, upload.filename);
        }

        return form;
      },
    );
  }

  private validateMediaGroupTypes(mediaItems: AdapterMedia[]): void {
    const types = mediaItems.map((item) =>
      this.toTelegramInputMediaType(item.type),
    );

    const hasAudio = types.includes("audio");
    const hasDocument = types.includes("document");

    if (hasAudio && !types.every((type) => type === "audio")) {
      throw new Error(
        "Telegram media groups that include audio must contain only audio attachments",
      );
    }

    if (hasDocument && !types.every((type) => type === "document")) {
      throw new Error(
        "Telegram media groups that include documents must contain only document attachments",
      );
    }
  }

  private getTelegramSendMethod(
    mediaType: AdapterMedia["type"],
  ): { method: string; mediaField: string } {
    switch (this.toTelegramInputMediaType(mediaType)) {
      case "photo":
        return { method: "sendPhoto", mediaField: "photo" };
      case "video":
        return { method: "sendVideo", mediaField: "video" };
      case "audio":
        return { method: "sendAudio", mediaField: "audio" };
      case "document":
      default:
        return { method: "sendDocument", mediaField: "document" };
    }
  }

  private toTelegramInputMediaType(
    mediaType: AdapterMedia["type"],
  ): TelegramInputMediaType {
    switch (mediaType) {
      case "image":
        return "photo";
      case "video":
        return "video";
      case "audio":
        return "audio";
      case "document":
      default:
        return "document";
    }
  }

  private buildMediaFilename(media: AdapterMedia): string {
    const provided = media.filename?.trim();
    if (provided) {
      return provided;
    }

    const ext = this.getExtensionFromMime(media.mimeType, media.type);
    return `attachment.${ext}`;
  }

  private getExtensionFromMime(
    mimeType: string,
    mediaType: AdapterMedia["type"],
  ): string {
    const normalized = mimeType.split(";")[0].trim().toLowerCase();
    const mapping: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "application/pdf": "pdf",
      "application/zip": "zip",
      "text/plain": "txt",
      "application/json": "json",
    };

    return mapping[normalized] || (mediaType === "document" ? "bin" : mediaType);
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

    if (!update || typeof update !== "object") {
      return {
        ok: false,
        status: 400,
        error: "Invalid Telegram update payload",
      };
    }

    const message = this.extractMessage(update);
    const updateId = this.normalizeUpdateId(update.update_id);
    if (!message) {
      return { ok: true };
    }

    const deliveryId = updateId === null
      ? `message:${message.chat.id}:${message.message_id}`
      : String(updateId);
    await this.inboundDeliveries.enqueue(deliveryId, message);
    // Commit both the provider payload and its wake-up before returning the
    // webhook acknowledgement. Media can be reconstructed from Telegram file
    // ids in the stored message on every attempt.
    if (!this.canProcessInbound()) {
      return { ok: true };
    }
    await this.scheduleInboundRetry(INBOUND_WAKE_DELAY_MS);

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

    const result = await this.callGateway<AdapterInboundResult>(
      "adapter.inbound",
      {
        adapter: "telegram",
        accountId: this.getAccountId(),
        message: inbound.message,
      },
      inbound.body,
    );
    if (!isTerminalAdapterInboundResult(result)) {
      return {
        terminal: false,
        error: "Kernel receipt is still in progress",
      };
    }
    if (!result.ok) {
      this.state.lastError = result.error || "Gateway rejected inbound message";
      await this.saveState();
      return { terminal: true };
    }

    this.state.lastActivity = Date.now();
    this.state.lastError = null;
    await this.saveState();
    return { terminal: true };
  }

  private normalizeUpdateId(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
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
      async (message) => this.forwardWebhookMessage(message),
    );
    if (attempt.state !== "pending") {
      return "completed";
    }

    this.state.lastError = attempt.error ?? "Gateway receipt is still in progress";
    await this.saveState();
    return "pending";
  }

  private async scheduleInboundRetry(
    delayMs = INBOUND_RETRY_DELAY_MS,
  ): Promise<void> {
    const retryAt = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > retryAt) {
      await this.ctx.storage.setAlarm(retryAt);
    }
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this.canProcessInbound()) {
      return;
    }

    const ids = await this.inboundDeliveries.pendingIds(INBOUND_RETRY_BATCH_SIZE);
    for (const deliveryId of ids) {
      await this.deliverPendingInbound(deliveryId);
    }
    if (await this.inboundDeliveries.hasPending()) {
      await this.scheduleInboundRetry();
    }
  }

  private extractMessage(update: TelegramUpdate): TelegramMessage | null {
    return update.message || update.channel_post || null;
  }

  private async toInboundMessage(message: TelegramMessage): Promise<TelegramInboundTransfer | null> {
    if (message.from?.is_bot && message.from.id === this.state.botUserId) {
      return null;
    }

    const text = this.extractText(message);
    if (!text) {
      return null;
    }

    const actor = this.toActor(message.from) ?? this.toChatActor(message.chat);
    const surfaceKind = this.mapSurfaceKind(message.chat.type);
    const surfaceName = this.getChatDisplayName(message.chat);

    const wasMentioned = this.computeWasMentioned(message, text);
    const media = await this.extractMediaAttachments(message);

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
        text,
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
      ...(media.body ? { body: media.body } : {}),
    };
  }

  private extractText(message: TelegramMessage): string | null {
    if (message.text && message.text.trim()) {
      return message.text.trim();
    }

    if (message.caption && message.caption.trim()) {
      return message.caption.trim();
    }

    if (message.photo) return "[Photo]";
    if (message.video) return "[Video]";
    if (message.video_note) return "[Video note]";
    if (message.audio) return "[Audio]";
    if (message.voice) return "[Voice note]";
    if (message.document) return "[Document]";
    if (message.animation) return "[Animation]";
    if (message.sticker) return "[Sticker]";

    return null;
  }

  private async extractMediaAttachments(
    message: TelegramMessage,
  ): Promise<AdapterMediaBundle> {
    const sources = this.getTelegramMediaSources(message);
    const media: AdapterMediaPart[] = [];
    let bodyBytes = 0;

    for (const source of sources) {
      const part = await this.sourceToAdapterMedia(
        source,
        MAX_MEDIA_TOTAL_BODY_BYTES - bodyBytes,
      );
      if (part) {
        media.push(part);
        bodyBytes += part.body?.length ?? 0;
      }
    }

    return await bundleAdapterMedia(media);
  }

  private getTelegramMediaSources(
    message: TelegramMessage,
  ): TelegramInboundMediaSource[] {
    const sources: TelegramInboundMediaSource[] = [];
    const messageId = String(message.message_id);

    const photo = this.pickLargestPhoto(message.photo);
    if (photo) {
      sources.push({
        type: "image",
        fileId: photo.file_id,
        mimeType: "image/jpeg",
        filename: `telegram-photo-${messageId}.jpg`,
        size: photo.file_size,
      });
    }

    const video = this.sourceFromTelegramFile(
      message.video,
      "video",
      "video/mp4",
      `telegram-video-${messageId}.mp4`,
    );
    if (video) sources.push(video);

    const videoNote = this.sourceFromTelegramFile(
      message.video_note,
      "video",
      "video/mp4",
      `telegram-video-note-${messageId}.mp4`,
    );
    if (videoNote) sources.push(videoNote);

    const audio = this.sourceFromTelegramFile(
      message.audio,
      "audio",
      "audio/mpeg",
      `telegram-audio-${messageId}.mp3`,
    );
    if (audio) sources.push(audio);

    const voice = this.sourceFromTelegramFile(
      message.voice,
      "audio",
      "audio/ogg",
      `telegram-voice-${messageId}.ogg`,
    );
    if (voice) sources.push(voice);

    const document = this.sourceFromTelegramFile(
      message.document,
      "document",
      "application/octet-stream",
      `telegram-document-${messageId}.bin`,
    );
    if (document) sources.push(document);

    const animationMime = message.animation?.mime_type || "video/mp4";
    const animation = this.sourceFromTelegramFile(
      message.animation,
      this.inferMediaTypeFromMime(animationMime),
      animationMime,
      `telegram-animation-${messageId}.${this.getExtensionFromMime(
        animationMime,
        this.inferMediaTypeFromMime(animationMime),
      )}`,
    );
    if (animation) sources.push(animation);

    const sticker = this.sourceFromTelegramSticker(message.sticker, messageId);
    if (sticker) sources.push(sticker);

    return sources;
  }

  private pickLargestPhoto(
    photos: TelegramPhotoSize[] | undefined,
  ): TelegramPhotoSize | null {
    if (!photos || photos.length === 0) {
      return null;
    }

    return photos.reduce((largest, photo) => {
      const largestSize = largest.file_size ?? 0;
      const nextSize = photo.file_size ?? 0;
      if (nextSize > largestSize) return photo;

      const largestPixels = (largest.width ?? 0) * (largest.height ?? 0);
      const nextPixels = (photo.width ?? 0) * (photo.height ?? 0);
      return nextPixels > largestPixels ? photo : largest;
    });
  }

  private sourceFromTelegramFile(
    file: TelegramFileAttachment | undefined,
    type: AdapterMedia["type"],
    defaultMimeType: string,
    defaultFilename: string,
  ): TelegramInboundMediaSource | null {
    if (!file?.file_id) {
      return null;
    }

    const mimeType = file.mime_type || defaultMimeType;
    return {
      type,
      fileId: file.file_id,
      mimeType,
      filename: file.file_name || defaultFilename,
      size: file.file_size,
      duration: file.duration,
    };
  }

  private sourceFromTelegramSticker(
    sticker: TelegramStickerAttachment | undefined,
    messageId: string,
  ): TelegramInboundMediaSource | null {
    if (!sticker?.file_id) {
      return null;
    }

    const mimeType =
      sticker.mime_type ||
      (sticker.is_video
        ? "video/webm"
        : sticker.is_animated
          ? "application/x-tgsticker"
          : "image/webp");
    const type = sticker.is_video
      ? "video"
      : sticker.is_animated
        ? "document"
        : "image";

    return {
      type,
      fileId: sticker.file_id,
      mimeType,
      filename:
        sticker.file_name ||
        `telegram-sticker-${messageId}.${this.getExtensionFromMime(mimeType, type)}`,
      size: sticker.file_size,
    };
  }

  private async sourceToAdapterMedia(
    source: TelegramInboundMediaSource,
    remainingBodyBytes: number,
  ): Promise<AdapterMediaPart | null> {
    const base: Omit<AdapterMedia, "body"> = {
      type: source.type,
      mimeType: source.mimeType,
      filename: source.filename,
      size: source.size,
      duration: source.duration,
    };

    if (remainingBodyBytes <= 0) {
      return null;
    }
    if (
      source.size !== undefined
      && (!Number.isSafeInteger(source.size) || source.size < 0)
    ) {
      console.log(
        `[TelegramAccount:${this.getAccountId()}] Media ${source.fileId} has an invalid size`,
      );
      return null;
    }
    const maxBytes = Math.min(MAX_MEDIA_BODY_BYTES, remainingBodyBytes);
    if (typeof source.size === "number" && source.size > maxBytes) {
      console.log(
        `[TelegramAccount:${this.getAccountId()}] Media ${source.fileId} exceeds transfer limit (${source.size} bytes)`,
      );
      return null;
    }

    try {
      const file = await this.callTelegramApi<TelegramFile>("getFile", {
        file_id: source.fileId,
      });
      const size = file.file_size ?? source.size;
      const withSize: Omit<AdapterMedia, "body"> = { ...base, size };

      if (!file.file_path) {
        return null;
      }
      if (
        size !== undefined
        && (!Number.isSafeInteger(size) || size < 0)
      ) {
        return null;
      }
      if (typeof size === "number" && size > maxBytes) {
        console.log(
          `[TelegramAccount:${this.getAccountId()}] Media ${source.fileId} exceeds transfer limit (${size} bytes)`,
        );
        return null;
      }

      const body = await this.downloadTelegramFile(file.file_path, size, maxBytes);
      if (!body) {
        return null;
      }

      return {
        media: { ...withSize, size: body.length },
        body,
      };
    } catch (error) {
      console.warn(
        `[TelegramAccount:${this.getAccountId()}] Failed to download media ${source.fileId}:`,
        error,
      );
      return null;
    }
  }

  private async downloadTelegramFile(
    filePath: string,
    expectedSize?: number,
    maxBytes = MAX_MEDIA_BODY_BYTES,
  ): Promise<BinaryBody | null> {
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

  private inferMediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
    const normalized = mimeType.split(";")[0].trim().toLowerCase();
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("audio/")) return "audio";
    if (normalized.startsWith("video/")) return "video";
    return "document";
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
      const status = await this.getStatus();
      await this.callGateway("adapter.state.update", {
        adapter: "telegram",
        accountId: this.getAccountId(),
        status,
      });
    } catch (error) {
      console.error(
        `[TelegramAccount:${this.getAccountId()}] Failed to notify status:`,
        error,
      );
    }
  }

  private async callGateway<T = unknown>(
    call: string,
    args: unknown,
    body?: BinaryBody,
  ): Promise<T> {
    const frame: GatewayRequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
      ...(body ? { body } : {}),
    };

    let response: GatewayFrame | null;
    try {
      response = await this.env.GATEWAY.serviceFrame(frame);
    } catch (error) {
      await cancelBinaryBody(body, error);
      throw error;
    }
    if (!response || response.type !== "res") {
      await cancelBinaryBody(body, "No response from gateway serviceFrame");
      throw new Error("No response from gateway serviceFrame");
    }
    if (!response.ok) {
      throw new Error(response.error?.message || `Gateway error on ${call}`);
    }

    return (response.data ?? {}) as T;
  }
}
