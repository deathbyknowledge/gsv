import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  cancelBinaryBody,
  readAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  validateAdapterMediaBody,
} from "../../shared/src/media-body";
import type {
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  BinaryBody,
} from "./types";
import {
  postSlackMessage,
  requireSlackId,
  SlackApiError,
  type SlackFetch,
  type SlackUploadFile,
  uploadSlackFiles,
} from "./slack-api";
import { MAX_SLACK_MEDIA_ITEMS } from "./slack-media";
import { buildSlackApprovalBlocks } from "./slack-interactions";

export type SlackDeliveryOptions = {
  slackFetch?: SlackFetch;
  attributedActorId?: string;
};

export async function deliverSlackMessage(
  deliveries: DeliveryLedger,
  botToken: string | null,
  message: AdapterOutboundMessage,
  body?: BinaryBody,
  options: SlackDeliveryOptions = {},
): Promise<AdapterSendResult> {
  if (!botToken) {
    await cancelBinaryBody(body, "Slack bot token is not configured");
    return { ok: false, error: "Slack bot token is not configured" };
  }

  let channel: string;
  let renderedText: string;
  try {
    channel = requireSlackId(message.surface.id, "Slack channel");
    renderedText = renderSlackMessageText(message, options.attributedActorId);
  } catch (error) {
    await cancelBinaryBody(body, error);
    return { ok: false, error: safeError(error) };
  }
  const media = message.media ?? [];
  if (!renderedText && media.length === 0) {
    await cancelBinaryBody(body, "Slack messages require text or media");
    return { ok: false, error: "Slack messages require text or media" };
  }
  if (media.length > MAX_SLACK_MEDIA_ITEMS) {
    await cancelBinaryBody(body, "Slack supports at most 20 attachments per message");
    return { ok: false, error: "Slack supports at most 20 attachments per message" };
  }
  try {
    validateAdapterMediaBody(media, body, {
      maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
      maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
    });
  } catch (error) {
    await cancelBinaryBody(body, error);
    return { ok: false, error: safeMediaError(error) };
  }

  let mediaBytes: Array<Uint8Array | undefined>;
  try {
    mediaBytes = await readAdapterMediaBody(media, body, {
      maxBytes: SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
      maxPartBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
    });
  } catch {
    return { ok: false, error: "Could not read Slack media body", retryable: true };
  }
  let uploadFiles: SlackUploadFile[];
  try {
    uploadFiles = prepareSlackUploadFiles(media, mediaBytes);
  } catch (error) {
    return { ok: false, error: safeMediaError(error) };
  }

  let fingerprint: string;
  try {
    fingerprint = await fingerprintOutboundDelivery({
      ...message,
      text: renderedText,
    }, mediaBytes);
  } catch {
    return { ok: false, error: "Could not fingerprint Slack delivery", retryable: true };
  }
  let claim;
  try {
    claim = await deliveries.claim(message.deliveryId, fingerprint);
  } catch {
    return { ok: false, error: "Slack delivery ledger unavailable", retryable: true };
  }
  if (!claim.claimed) return claim.result;

  const fail = async (
    kind: DeliveryFailureKind,
    error: string,
  ): Promise<AdapterSendResult> => {
    if (kind === "retryable") {
      await deliveries.releaseRetryable(message.deliveryId, claim.attemptId);
      return { ok: false, error, retryable: true };
    }
    if (kind === "ambiguous") {
      await deliveries.failAmbiguous(message.deliveryId, claim.attemptId, error);
      return { ok: false, error, ambiguous: true };
    }
    await deliveries.failPermanent(message.deliveryId, claim.attemptId, error);
    return { ok: false, error };
  };

  try {
    const approvalBlocks = message.surface.kind === "dm" && uploadFiles.length === 0
      ? buildSlackApprovalBlocks(renderedText, message.routeGeneration)
      : undefined;
    const providerMessageId = uploadFiles.length > 0
      ? (await uploadSlackFiles(botToken, {
          channel,
          text: renderedText,
          threadTs: message.surface.threadId,
          files: uploadFiles,
        }, options.slackFetch)).fileIds[0]
      : (await postSlackMessage(botToken, {
          channel,
          text: renderedText,
          threadTs: message.surface.threadId,
          blocks: approvalBlocks,
        }, options.slackFetch)).ts;
    await deliveries.succeed(message.deliveryId, claim.attemptId, providerMessageId);
    return { ok: true, messageId: providerMessageId };
  } catch (error) {
    const kind = error instanceof SlackApiError ? error.kind : "permanent";
    return await fail(kind, "Slack delivery failed");
  }
}

export function renderSlackMessageText(
  message: AdapterOutboundMessage,
  attributedActorId?: string,
): string {
  const text = message.text.trim();
  if (message.surface.kind === "dm") return text;
  if (!attributedActorId || message.actorId !== attributedActorId) {
    throw new Error("Slack shared-surface attribution is invalid");
  }
  const actorId = requireSlackId(attributedActorId, "Slack actor");
  const attribution = `*From <@${actorId}>'s GSV:*`;
  return text ? `${attribution}\n${text}` : message.media?.length ? attribution : "";
}

export function prepareSlackUploadFiles(
  media: readonly AdapterMedia[],
  mediaBytes: readonly (Uint8Array | undefined)[],
): SlackUploadFile[] {
  return media.map((item, index) => {
    const bytes = mediaBytes[index];
    if (!bytes) {
      throw new Error("Slack media attachments must include GSV resource bytes");
    }
    return {
      filename: item.filename?.trim() || fallbackSlackFilename(item, index),
      mimeType: item.mimeType,
      bytes,
    };
  });
}

function fallbackSlackFilename(media: AdapterMedia, index: number): string {
  const normalized = media.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extensions = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
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
  const extension = Object.entries(extensions).find(([mime]) => mime === normalized)?.[1]
    ?? (media.type === "document" ? "bin" : media.type);
  return `attachment-${index + 1}.${extension}`;
}

function safeMediaError<T>(error: T): string {
  const message = error instanceof Error ? error.message : String(error);
  return /Slack|Adapter media|attachment|body|limit|file/i.test(message)
    ? message
    : "Slack media delivery is invalid";
}

function safeError<T>(error: T): string {
  return error instanceof Error && /Slack|attribution|text/.test(error.message)
    ? error.message
    : "Slack delivery is invalid";
}
