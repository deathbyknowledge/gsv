import type { AdapterMedia } from "./types";
import type { callManagedTelegramApi } from "./managed-telegram-api";
import {
  buildTelegramReplyParameters,
  callTelegramApiWithMarkdownCaption,
  type TelegramReplyParameters,
} from "./telegram-formatting";

export type TelegramSentMediaMessage = { message_id: number };

export type TelegramMediaApiCall = <T>(
  method: string,
  payload: Parameters<typeof callManagedTelegramApi>[2],
) => Promise<T>;

type TelegramInputMediaType = "photo" | "video" | "audio" | "document";

type TelegramInputMedia = {
  type: TelegramInputMediaType;
  media: string;
  caption?: string;
  parse_mode?: "HTML";
};

type TelegramMediaPayload = {
  chat_id: string;
  photo?: string;
  video?: string;
  audio?: string;
  document?: string;
  caption?: string;
  parse_mode?: "HTML";
  reply_parameters?: TelegramReplyParameters;
};

type TelegramSendMethod = { method: string; mediaField: TelegramInputMediaType };

export async function sendTelegramMediaMessage(
  callApi: TelegramMediaApiCall,
  chatId: string,
  media: AdapterMedia,
  bytes: Uint8Array | undefined,
  text: string,
  replyToMessageId?: number,
): Promise<TelegramSentMediaMessage> {
  const { method, mediaField } = telegramSendMethod(media.type);
  const caption = text.trim() || undefined;
  const replyParameters = buildTelegramReplyParameters(replyToMessageId);

  if (media.url) {
    return await callTelegramApiWithMarkdownCaption(
      (apiMethod, payload) => callApi<TelegramSentMediaMessage>(apiMethod, payload),
      method,
      caption,
      (formattedCaption, parseMode) => {
        const payload: TelegramMediaPayload = {
          chat_id: chatId,
          [mediaField]: media.url,
        };
        if (formattedCaption) payload.caption = formattedCaption;
        if (parseMode) payload.parse_mode = parseMode;
        if (replyParameters) payload.reply_parameters = replyParameters;
        return payload;
      },
    );
  }

  if (!bytes) {
    throw new Error("Telegram media attachment must include either a binary body or a URL");
  }
  const blob = new Blob([bytes], { type: media.mimeType });
  return await callTelegramApiWithMarkdownCaption(
    (apiMethod, payload) => callApi<TelegramSentMediaMessage>(apiMethod, payload),
    method,
    caption,
    (formattedCaption, parseMode) => {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (formattedCaption) form.set("caption", formattedCaption);
      if (parseMode) form.set("parse_mode", parseMode);
      if (replyParameters) {
        form.set("reply_parameters", JSON.stringify(replyParameters));
      }
      form.set(mediaField, blob, telegramMediaFilename(media));
      return form;
    },
  );
}

export async function sendTelegramMediaGroupMessage(
  callApi: TelegramMediaApiCall,
  chatId: string,
  mediaItems: readonly AdapterMedia[],
  mediaBytes: readonly (Uint8Array | undefined)[],
  text: string,
  replyToMessageId?: number,
): Promise<TelegramSentMediaMessage[]> {
  if (mediaItems.length < 2 || mediaItems.length > 10) {
    throw new Error("Telegram media groups require 2-10 attachments");
  }
  validateMediaGroupTypes(mediaItems);

  const caption = text.trim() || undefined;
  const replyParameters = buildTelegramReplyParameters(replyToMessageId);
  const preparedMedia: Array<Pick<TelegramInputMedia, "type" | "media">> = [];
  const uploadEntries: Array<{ field: string; blob: Blob; filename: string }> = [];

  for (const [index, media] of mediaItems.entries()) {
    const item: Pick<TelegramInputMedia, "type" | "media"> = {
      type: telegramInputMediaType(media.type),
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
        filename: telegramMediaFilename(media),
      });
    } else {
      throw new Error("Telegram media attachment must include either a binary body or a URL");
    }
    preparedMedia.push(item);
  }

  return await callTelegramApiWithMarkdownCaption(
    (method, payload) => callApi<TelegramSentMediaMessage[]>(method, payload),
    "sendMediaGroup",
    caption,
    (formattedCaption, parseMode) => {
      const inputMedia = preparedMedia.map<TelegramInputMedia>((media, index) => {
        const item: TelegramInputMedia = { ...media };
        if (index === 0 && formattedCaption) item.caption = formattedCaption;
        if (index === 0 && parseMode) item.parse_mode = parseMode;
        return item;
      });
      if (uploadEntries.length === 0) {
        const payload: TelegramMediaPayload & { media: TelegramInputMedia[] } = {
          chat_id: chatId,
          media: inputMedia,
        };
        if (replyParameters) payload.reply_parameters = replyParameters;
        return payload;
      }
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("media", JSON.stringify(inputMedia));
      if (replyParameters) {
        form.set("reply_parameters", JSON.stringify(replyParameters));
      }
      for (const upload of uploadEntries) {
        form.set(upload.field, upload.blob, upload.filename);
      }
      return form;
    },
  );
}

function validateMediaGroupTypes(mediaItems: readonly AdapterMedia[]): void {
  const types = mediaItems.map((item) => telegramInputMediaType(item.type));
  if (types.includes("audio") && !types.every((type) => type === "audio")) {
    throw new Error("Telegram media groups that include audio must contain only audio attachments");
  }
  if (types.includes("document") && !types.every((type) => type === "document")) {
    throw new Error(
      "Telegram media groups that include documents must contain only document attachments",
    );
  }
}

function telegramSendMethod(
  mediaType: AdapterMedia["type"],
): TelegramSendMethod {
  switch (telegramInputMediaType(mediaType)) {
    case "photo":
      return { method: "sendPhoto", mediaField: "photo" };
    case "video":
      return { method: "sendVideo", mediaField: "video" };
    case "audio":
      return { method: "sendAudio", mediaField: "audio" };
    case "document":
      return { method: "sendDocument", mediaField: "document" };
  }
}

function telegramInputMediaType(mediaType: AdapterMedia["type"]): TelegramInputMediaType {
  switch (mediaType) {
    case "image":
      return "photo";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
      return "document";
  }
}

function telegramMediaFilename(media: AdapterMedia): string {
  const provided = media.filename?.trim();
  if (provided) return provided;
  const normalized = media.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const mapping = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "text/plain": "txt",
    "video/mp4": "mp4",
    "video/webm": "webm",
  } satisfies Record<string, string>;
  const extension = Object.entries(mapping).find(([mimeType]) => mimeType === normalized)?.[1]
    ?? (media.type === "document" ? "bin" : media.type);
  return `attachment.${extension}`;
}
