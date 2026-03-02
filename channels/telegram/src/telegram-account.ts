import { DurableObject } from "cloudflare:workers";
import type {
  ChannelAccountStatus,
  ChannelInboundMessage,
  ChannelMedia,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelSender,
} from "./types";

type GatewayChannelBinding = Fetcher & {
  channelInbound: (
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ) => Promise<{ ok: boolean; sessionKey?: string; status?: string; error?: string }>;
  channelStatusChanged: (
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ) => Promise<void>;
};

interface Env {
  GATEWAY: GatewayChannelBinding;
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
  photo?: unknown[];
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  sticker?: unknown;
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

type TelegramInputMediaType = "photo" | "video" | "audio" | "document";

type TelegramInputMedia = {
  type: TelegramInputMediaType;
  media: string;
  caption?: string;
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
  lastUpdateId: number | null;
  lastError: string | null;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

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
    lastUpdateId: null,
    lastError: null,
  };

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const stored = await this.ctx.storage.get<TelegramAccountState>("state");
    if (stored) {
      this.state = { ...this.state, ...stored };
    }

    this.loaded = true;
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

    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: isFormDataPayload
        ? undefined
        : {
            "Content-Type": "application/json; charset=utf-8",
          },
      body: isFormDataPayload ? payload : JSON.stringify(payload),
    });

    const responseText = await response.text();
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
      throw new Error(
        `Telegram API ${method} failed (${response.status}): ${details || response.statusText}`,
      );
    }

    if (!parsed) {
      throw new Error(`Telegram API ${method} returned an empty response`);
    }

    if (!parsed.ok) {
      const code = parsed.error_code ? ` ${parsed.error_code}` : "";
      throw new Error(
        `Telegram API ${method} error${code}: ${parsed.description || "Unknown error"}`,
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
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "edited_channel_post",
        ],
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
    this.state.lastError = null;
    await this.saveState();
    await this.notifyGatewayStatus();
  }

  async getStatus(): Promise<ChannelAccountStatus> {
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
    message: ChannelOutboundMessage,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    await this.ensureLoaded();

    if (!this.state.botToken || !this.state.authenticated) {
      return { ok: false, error: "Telegram account is not authenticated" };
    }

    const trimmedText = message.text.trim();
    const media = message.media ?? [];

    if (!trimmedText && media.length === 0) {
      return { ok: false, error: "Telegram requires text or media" };
    }

    try {
      const replyToMessageId = message.replyToId
        ? Number.parseInt(message.replyToId, 10)
        : undefined;
      let sentMessageId: string | undefined;

      if (media.length === 0) {
        const sent = await this.callTelegramApi<TelegramMessage>("sendMessage", {
          chat_id: message.peer.id,
          text: trimmedText,
          ...(Number.isFinite(replyToMessageId)
            ? { reply_to_message_id: replyToMessageId }
            : {}),
        });
        sentMessageId = String(sent.message_id);
      } else if (media.length === 1) {
        const sent = await this.sendMediaMessage(
          message.peer.id,
          media[0],
          trimmedText,
          replyToMessageId,
        );
        sentMessageId = String(sent.message_id);
      } else {
        if (media.length > 10) {
          return {
            ok: false,
            error: "Telegram media groups support at most 10 attachments",
          };
        }

        const sent = await this.sendMediaGroupMessage(
          message.peer.id,
          media,
          trimmedText,
          replyToMessageId,
        );
        sentMessageId = sent[0] ? String(sent[0].message_id) : undefined;
      }

      this.state.lastActivity = Date.now();
      this.state.lastError = null;
      await this.saveState();

      return { ok: true, messageId: sentMessageId };
    } catch (error) {
      const messageText = toErrorMessage(error);
      this.state.lastError = messageText;
      await this.saveState();
      return { ok: false, error: messageText };
    }
  }

  private async sendMediaMessage(
    chatId: string,
    media: ChannelMedia,
    text: string,
    replyToMessageId?: number,
  ): Promise<TelegramMessage> {
    const { method, mediaField } = this.getTelegramSendMethod(media.type);
    const caption = text.trim() || undefined;

    if (media.url) {
      return this.callTelegramApi<TelegramMessage>(method, {
        chat_id: chatId,
        [mediaField]: media.url,
        ...(caption ? { caption } : {}),
        ...(Number.isFinite(replyToMessageId)
          ? { reply_to_message_id: replyToMessageId }
          : {}),
      });
    }

    if (media.data) {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (caption) {
        form.set("caption", caption);
      }
      if (Number.isFinite(replyToMessageId)) {
        form.set("reply_to_message_id", String(replyToMessageId));
      }

      const filename = this.buildMediaFilename(media);
      const fileBytes = this.decodeBase64(media.data);
      form.set(
        mediaField,
        new Blob([fileBytes], { type: media.mimeType }),
        filename,
      );

      return this.callTelegramApi<TelegramMessage>(method, form);
    }

    throw new Error(
      "Telegram media attachment must include either base64 data or a URL",
    );
  }

  private async sendMediaGroupMessage(
    chatId: string,
    mediaItems: ChannelMedia[],
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
    const hasBinaryUpload = mediaItems.some((item) => !!item.data);
    const inputMedia: TelegramInputMedia[] = [];
    const uploadEntries: Array<{ field: string; blob: Blob; filename: string }> = [];

    for (const [index, media] of mediaItems.entries()) {
      const inputType = this.toTelegramInputMediaType(media.type);
      const item: TelegramInputMedia = {
        type: inputType,
        media: "",
      };

      if (index === 0 && caption) {
        item.caption = caption;
      }

      if (media.url) {
        item.media = media.url;
      } else if (media.data) {
        const field = `file${index + 1}`;
        item.media = `attach://${field}`;
        uploadEntries.push({
          field,
          blob: new Blob([this.decodeBase64(media.data)], { type: media.mimeType }),
          filename: this.buildMediaFilename(media),
        });
      } else {
        throw new Error(
          "Telegram media attachment must include either base64 data or a URL",
        );
      }

      inputMedia.push(item);
    }

    if (!hasBinaryUpload) {
      return this.callTelegramApi<TelegramMessage[]>("sendMediaGroup", {
        chat_id: chatId,
        media: inputMedia,
        ...(Number.isFinite(replyToMessageId)
          ? { reply_to_message_id: replyToMessageId }
          : {}),
      });
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

    return this.callTelegramApi<TelegramMessage[]>("sendMediaGroup", form);
  }

  private validateMediaGroupTypes(mediaItems: ChannelMedia[]): void {
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
    mediaType: ChannelMedia["type"],
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
    mediaType: ChannelMedia["type"],
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

  private buildMediaFilename(media: ChannelMedia): string {
    const provided = media.filename?.trim();
    if (provided) {
      return provided;
    }

    const ext = this.getExtensionFromMime(media.mimeType, media.type);
    return `attachment.${ext}`;
  }

  private decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private getExtensionFromMime(
    mimeType: string,
    mediaType: ChannelMedia["type"],
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

  async setTyping(peer: ChannelPeer, typing: boolean): Promise<void> {
    await this.ensureLoaded();

    if (!typing || !this.state.botToken || !this.state.authenticated) {
      return;
    }

    try {
      await this.callTelegramApi<boolean>("sendChatAction", {
        chat_id: peer.id,
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
    if (!message) {
      return { ok: true };
    }

    const inbound = this.toInboundMessage(message);
    if (!inbound) {
      return { ok: true };
    }

    try {
      const result = await this.env.GATEWAY.channelInbound(
        "telegram",
        this.getAccountId(),
        inbound,
      );

      if (!result.ok) {
        const error = result.error || "Gateway rejected inbound message";
        this.state.lastError = error;
        await this.saveState();
        return { ok: false, status: 500, error };
      }

      this.state.lastActivity = Date.now();
      this.state.lastUpdateId =
        typeof update.update_id === "number" ? update.update_id : null;
      this.state.lastError = null;
      await this.saveState();
      return { ok: true };
    } catch (error) {
      const messageText = toErrorMessage(error);
      this.state.lastError = messageText;
      await this.saveState();
      return { ok: false, status: 500, error: messageText };
    }
  }

  private extractMessage(update: TelegramUpdate): TelegramMessage | null {
    return (
      update.message ||
      update.edited_message ||
      update.channel_post ||
      update.edited_channel_post ||
      null
    );
  }

  private toInboundMessage(message: TelegramMessage): ChannelInboundMessage | null {
    if (message.from?.is_bot && message.from.id === this.state.botUserId) {
      return null;
    }

    const text = this.extractText(message);
    if (!text) {
      return null;
    }

    const sender = this.toSender(message.from);
    const peerKind = this.mapPeerKind(message.chat.type);
    const peerName = this.getChatDisplayName(message.chat);

    const wasMentioned = this.computeWasMentioned(message, text);

    return {
      messageId: String(message.message_id),
      peer: {
        kind: peerKind,
        id: String(message.chat.id),
        name: peerName,
        handle: message.chat.username ? `@${message.chat.username}` : undefined,
      },
      sender,
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

  private mapPeerKind(chatType: TelegramChatType): "dm" | "group" | "channel" {
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

  private toSender(user?: TelegramUser): ChannelSender | undefined {
    if (!user) return undefined;

    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

    return {
      id: String(user.id),
      name: name || undefined,
      handle: user.username ? `@${user.username}` : undefined,
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
      await this.env.GATEWAY.channelStatusChanged(
        "telegram",
        this.getAccountId(),
        status,
      );
    } catch (error) {
      console.error(
        `[TelegramAccount:${this.getAccountId()}] Failed to notify status:`,
        error,
      );
    }
  }
}
