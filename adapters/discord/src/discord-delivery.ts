import {
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../../shared/src/delivery-ledger";
import {
  cancelResponseBody,
  cancelBinaryBody,
  readResponseBodyBytes,
  readAdapterMediaBody,
  validateAdapterMediaBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
} from "../../shared/src/media-body";
import type {
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSendResult,
  BinaryBody,
} from "../../shared/src/types";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_MEDIA_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_PART_BYTES;
const MAX_MEDIA_TOTAL_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES;

export async function deliverDiscordMessage(
  deliveries: DeliveryLedger,
  botToken: string | null,
  message: AdapterOutboundMessage,
  binaryBody?: BinaryBody,
): Promise<AdapterSendResult> {
  if (!botToken) {
    await cancelBinaryBody(binaryBody, "No Discord bot token configured");
    return { ok: false, error: "No bot token configured" };
  }

  const channelId = message.surface.id.trim();
  const payload: Record<string, unknown> = {};
  const hasText = message.text.trim().length > 0;
  const media = message.media ?? [];

  if (!channelId) {
    await cancelBinaryBody(binaryBody, "Discord channel ID is required");
    return { ok: false, error: "Discord channel ID is required" };
  }
  if (!hasText && media.length === 0) {
    await cancelBinaryBody(binaryBody, "Discord messages require text or media");
    return { ok: false, error: "Discord messages require text or media" };
  }
  if (media.length > 10) {
    await cancelBinaryBody(binaryBody, "Discord supports at most 10 attachments per message");
    return {
      ok: false,
      error: "Discord supports at most 10 attachments per message",
    };
  }

  try {
    validateAdapterMediaBody(media, binaryBody, {
      maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
      maxPartBytes: MAX_MEDIA_BODY_BYTES,
    });
  } catch (error) {
    await cancelBinaryBody(binaryBody, error);
    return { ok: false, error: toErrorMessage(error) };
  }

  let mediaBytes: Array<Uint8Array | undefined>;
  try {
    mediaBytes = await readAdapterMediaBody(media, binaryBody, {
      maxBytes: MAX_MEDIA_TOTAL_BODY_BYTES,
      maxPartBytes: MAX_MEDIA_BODY_BYTES,
    });
  } catch (error) {
    return {
      ok: false,
      error: `Could not read Discord media body: ${toErrorMessage(error)}`,
      retryable: true,
    };
  }

  let requestFingerprint: string;
  try {
    requestFingerprint = await fingerprintOutboundDelivery(message, mediaBytes);
  } catch (error) {
    return {
      ok: false,
      error: `Could not fingerprint Discord delivery: ${toErrorMessage(error)}`,
      retryable: true,
    };
  }

  let claim;
  try {
    claim = await deliveries.claim(message.deliveryId, requestFingerprint);
  } catch (error) {
    return {
      ok: false,
      error: `Discord delivery ledger unavailable: ${toErrorMessage(error)}`,
      retryable: true,
    };
  }
  if (!claim.claimed) {
    return claim.result;
  }

  const { attemptId } = claim;
  const fail = async (
    kind: "retryable" | "permanent" | "ambiguous",
    error: string,
  ): Promise<AdapterSendResult> => {
    try {
      if (kind === "retryable") {
        await deliveries.releaseRetryable(message.deliveryId, attemptId);
      } else if (kind === "ambiguous") {
        await deliveries.failAmbiguous(message.deliveryId, attemptId, error);
      } else {
        await deliveries.failPermanent(message.deliveryId, attemptId, error);
      }
    } catch (ledgerError) {
      console.error("[DiscordGateway] Failed to persist delivery outcome", ledgerError);
    }
    return {
      ok: false,
      error,
      ...(kind === "retryable" ? { retryable: true } : {}),
      ...(kind === "ambiguous" ? { ambiguous: true } : {}),
    };
  };

  if (hasText) {
    payload.content = message.text;
  }
  if (message.replyToId) {
    payload.message_reference = { message_id: message.replyToId };
  }
  try {
    payload.nonce = await discordNonce(message.deliveryId);
  } catch (error) {
    return await fail(
      "retryable",
      `Could not derive Discord delivery nonce: ${toErrorMessage(error)}`,
    );
  }
  payload.enforce_nonce = true;

  let requestBody: BodyInit;
  try {
    if (media.length > 0) {
      const form = new FormData();
      const attachments: Array<{ id: number; filename: string }> = [];
      let uploadBytes = 0;

      for (const [index, attachment] of media.entries()) {
        const file = await prepareUploadFile(
          attachment,
          index,
          mediaBytes[index],
          MAX_MEDIA_TOTAL_BODY_BYTES - uploadBytes,
        );
        form.append(`files[${index}]`, file.blob, file.filename);
        attachments.push({ id: index, filename: file.filename });
        uploadBytes += file.blob.size;
      }

      payload.attachments = attachments;
      form.append("payload_json", JSON.stringify(payload));
      requestBody = form;
    } else {
      requestBody = JSON.stringify(payload);
    }
  } catch (error) {
    const kind = error instanceof DiscordPreparationError && error.retryable
      ? "retryable"
      : "permanent";
    return await fail(kind, toErrorMessage(error));
  }

  let response: Response;
  try {
    response = await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      botToken,
      body: requestBody,
    });
  } catch (error) {
    return await fail(
      "ambiguous",
      `Discord transport failed after delivery began: ${toErrorMessage(error)}`,
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    const error = `Discord API error: ${response.status} ${details}`;
    const retryable = response.status === 408
      || response.status === 429
      || response.status >= 500;
    return await fail(retryable ? "retryable" : "permanent", error);
  }

  let data: { id: string };
  try {
    data = await response.json<{ id: string }>();
    if (!data.id) {
      throw new Error("Discord response did not include a message ID");
    }
  } catch (error) {
    return await fail(
      "ambiguous",
      `Discord accepted the delivery but returned an unreadable response: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deliveries.succeed(message.deliveryId, attemptId, data.id);
  } catch (error) {
    console.error("[DiscordGateway] Failed to persist successful delivery", error);
    return {
      ok: false,
      error: "Discord accepted the delivery but its durable outcome could not be recorded",
      ambiguous: true,
    };
  }
  return { ok: true, messageId: data.id };
}

async function discordFetch(
  path: string,
  init: RequestInit & { botToken: string },
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bot ${init.botToken}`);
  const isFormDataBody = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (!headers.has("Content-Type") && init.body && !isFormDataBody) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  return await fetch(`${DISCORD_API}${path}`, { ...init, headers });
}

async function prepareUploadFile(
  media: AdapterMedia,
  index: number,
  bytes?: Uint8Array,
  remainingBytes = MAX_MEDIA_TOTAL_BODY_BYTES,
): Promise<{ blob: Blob; filename: string }> {
  const filename =
    media.filename
    || `attachment-${index + 1}.${getExtensionFromMime(media.mimeType, media.type)}`;

  const maxBytes = Math.min(MAX_MEDIA_BODY_BYTES, remainingBytes);
  if (maxBytes <= 0) {
    throw new Error("Discord media exceeds the total upload limit");
  }

  if (bytes) {
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Discord media exceeds upload limit (${bytes.byteLength} bytes)`);
    }
    return {
      blob: new Blob([bytes], { type: media.mimeType }),
      filename,
    };
  }

  if (media.url) {
    let response: Response;
    try {
      response = await fetch(media.url);
    } catch (error) {
      throw new DiscordPreparationError(
        `Could not download Discord media: ${toErrorMessage(error)}`,
        true,
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response, "Discord media download failed");
      throw new DiscordPreparationError(
        `Failed to fetch media from url (${response.status} ${response.statusText})`,
        response.status === 408
          || response.status === 429
          || response.status >= 500,
      );
    }
    let downloaded: Uint8Array;
    try {
      downloaded = await readResponseBodyBytes(response, {
        maxBytes,
        expectedBytes: media.size,
        label: "Discord media",
      });
    } catch (error) {
      const detail = toErrorMessage(error);
      throw new DiscordPreparationError(
        detail,
        !detail.includes("exceeds transfer limit"),
      );
    }
    return {
      blob: new Blob([downloaded], { type: media.mimeType }),
      filename,
    };
  }

  throw new Error("Media attachment must include a binary body or URL");
}

function getExtensionFromMime(
  mimeType: string,
  mediaType: AdapterMedia["type"],
): string {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  const mapping: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "application/pdf": "pdf",
  };

  const fromMime = mapping[normalized];
  if (fromMime) return fromMime;
  return mediaType === "document" ? "bin" : mediaType;
}

class DiscordPreparationError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

async function discordNonce(deliveryId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deliveryId)),
  );
  return Array.from(digest.subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
