import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  extractMessageContent,
  getContentType,
  getMediaKeys,
  type MediaType,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import {
  cancelResponseBody,
} from "../../shared/src/media-body";
import type { AdapterMediaPart } from "../../shared/src/media-body";
import type { AdapterMedia } from "../../shared/src/types";
import { errorMessage } from "./logging";

export const MAX_WHATSAPP_MEDIA_BYTES = 48 * 1024 * 1024;
// Outbound bodies remain live while Baileys streams an encrypted copy into the
// Workers in-memory /tmp filesystem. Keep the aggregate below half the inbound
// ceiling so both copies, hashing, and the socket runtime fit a 128 MiB isolate.
export const MAX_WHATSAPP_MEDIA_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_ENCRYPTED_MEDIA_BYTES = MAX_WHATSAPP_MEDIA_BYTES + 32;

type WhatsAppMediaNode = {
  mimetype?: string | null; fileName?: string | null; url?: string | null;
  directPath?: string | null; mediaKey?: Uint8Array | null;
  fileLength?: number | bigint | string; fileSha256?: Uint8Array | null;
  fileEncSha256?: Uint8Array | null; seconds?: number | null;
};

export class WhatsAppInboundMediaError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "WhatsAppInboundMediaError";
  }
}

class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super(`WhatsApp media HTTP ${status}`);
  }
}

export async function downloadWhatsAppMedia(
  socket: WASocket,
  originalMessage: WAMessage,
): Promise<AdapterMediaPart | null> {
  let message = originalMessage;
  try {
    return await downloadOnce(message);
  } catch (error) {
    if (error instanceof MediaHttpError && (error.status === 404 || error.status === 410)) {
      try {
        message = await socket.updateMediaMessage(message);
        return await downloadOnce(message);
      } catch (retryError) {
        throw classifyMediaError(retryError instanceof Error ? retryError : new Error(String(retryError)), true);
      }
    }
    throw classifyMediaError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function downloadOnce(message: WAMessage): Promise<AdapterMediaPart | null> {
  const extracted = extractMessageContent(message.message);
  const contentType = extracted ? getContentType(extracted) : undefined;
  const descriptor = contentType ? whatsAppMediaDescriptor(contentType) : null;
  if (!extracted || !contentType || !descriptor) return null;
  // SAFETY: the Baileys content discriminator selects the corresponding media node.
  const node = extracted[contentType] as WhatsAppMediaNode | null | undefined;
  if (!node || !node.mediaKey) {
    throw new WhatsAppInboundMediaError("WhatsApp media key is missing", false);
  }

  const expectedLength = normalizeByteLength(node.fileLength);
  if (expectedLength !== null && expectedLength > MAX_WHATSAPP_MEDIA_BYTES) {
    throw new WhatsAppInboundMediaError(
      `WhatsApp media exceeds ${MAX_WHATSAPP_MEDIA_BYTES} bytes`,
      false,
    );
  }

  const url = mediaDownloadUrl(node.url, node.directPath);
  if (!url) {
    throw new WhatsAppInboundMediaError("WhatsApp media URL is missing or unsafe", false);
  }
  let keys: Awaited<ReturnType<typeof getMediaKeys>>;
  try {
    keys = await getMediaKeys(node.mediaKey, descriptor.baileysType);
  } catch {
    throw new WhatsAppInboundMediaError("WhatsApp media key is invalid", false);
  }
  if (
    keys.iv.byteLength !== 16
    || keys.cipherKey.byteLength !== 32
    || keys.macKey?.byteLength !== 32
  ) {
    throw new WhatsAppInboundMediaError("WhatsApp media key is invalid", false);
  }
  let response: Response;
  try {
    response = await fetchWhatsAppMedia(url);
  } catch (error) {
    if (error instanceof WhatsAppInboundMediaError) throw error;
    throw new WhatsAppInboundMediaError(
      `WhatsApp media transport failed: ${errorMessage(error)}`,
      true,
    );
  }
  if (!response.ok) {
    await cancelResponseBody(response, "WhatsApp media download failed");
    throw new MediaHttpError(response.status);
  }

  const staged = await decryptAndValidateToTemporaryFile(response, {
    cipherKey: keys.cipherKey,
    iv: keys.iv,
    macKey: keys.macKey,
    expectedLength,
    expectedPlainSha256: node.fileSha256,
    expectedEncryptedSha256: node.fileEncSha256,
  });

  const mediaResult: AdapterMedia = {
    type: descriptor.type,
    mimeType: normalizeWhatsAppMimeType(node.mimetype, descriptor.defaultMimeType),
    size: staged.length,
  };
  const filename = descriptor.type === "document" ? normalizeWhatsAppFilename(node.fileName) : undefined;
  if (filename) mediaResult.filename = filename;
  const duration = normalizeWhatsAppDuration(node.seconds);
  if (duration !== undefined) mediaResult.duration = duration;
  return {
    media: mediaResult,
    body: {
      length: staged.length,
      stream: temporaryFileBody(staged.path),
    },
  };
}

async function decryptAndValidateToTemporaryFile(
  response: Response,
  options: {
    cipherKey: Uint8Array;
    iv: Uint8Array;
    macKey: Uint8Array;
    expectedLength: number | null;
    expectedPlainSha256?: Uint8Array | null;
    expectedEncryptedSha256?: Uint8Array | null;
  },
): Promise<{ path: string; length: number }> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_ENCRYPTED_MEDIA_BYTES) {
    await cancelResponseBody(response, "Encrypted WhatsApp media exceeds transfer limit");
    throw new WhatsAppInboundMediaError(
      `Encrypted WhatsApp media exceeds ${MAX_ENCRYPTED_MEDIA_BYTES} bytes`,
      false,
    );
  }
  if (!response.body) {
    throw new WhatsAppInboundMediaError("WhatsApp media has no response body", true);
  }

  const path = `/tmp/gsv-whatsapp-${crypto.randomUUID()}`;
  const writer = createWriteStream(path);
  const reader = response.body.getReader();
  const encryptedHash = createHash("sha256");
  const plainHash = createHash("sha256");
  const hmac = createHmac("sha256", options.macKey).update(options.iv);
  const decipher = (await import("node:crypto")).createDecipheriv(
    "aes-256-cbc",
    options.cipherKey,
    options.iv,
  );
  let encryptedLength = 0;
  let plainLength = 0;
  let tail = Buffer.alloc(0);

  const writePlain = async (chunk: Uint8Array): Promise<void> => {
    if (chunk.byteLength === 0) return;
    plainLength += chunk.byteLength;
    if (plainLength > MAX_WHATSAPP_MEDIA_BYTES) {
      throw new WhatsAppInboundMediaError(
        `WhatsApp media exceeds ${MAX_WHATSAPP_MEDIA_BYTES} bytes`,
        false,
      );
    }
    plainHash.update(chunk);
    if (!writer.write(chunk)) await once(writer, "drain");
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(
        next.value,
      );
      encryptedLength += chunk.byteLength;
      if (encryptedLength > MAX_ENCRYPTED_MEDIA_BYTES) {
        throw new WhatsAppInboundMediaError(
          `Encrypted WhatsApp media exceeds ${MAX_ENCRYPTED_MEDIA_BYTES} bytes`,
          false,
        );
      }
      encryptedHash.update(chunk);
      const combined = tail.byteLength > 0 ? Buffer.concat([tail, chunk]) : chunk;
      if (combined.byteLength <= 10) {
        tail = Buffer.from(combined);
        continue;
      }
      const ciphertextEnd = combined.byteLength - 10;
      const ciphertext = combined.subarray(0, ciphertextEnd);
      tail = Buffer.from(combined.subarray(ciphertextEnd));
      hmac.update(ciphertext);
      await writePlain(decipher.update(ciphertext));
    }

    if (tail.byteLength !== 10 || (encryptedLength - 10) % 16 !== 0) {
      throw new WhatsAppInboundMediaError("WhatsApp media ciphertext is malformed", false);
    }
    try {
      await writePlain(decipher.final());
    } catch (error) {
      if (error instanceof WhatsAppInboundMediaError) throw error;
      throw new WhatsAppInboundMediaError("WhatsApp media decryption failed", false);
    }
    const calculatedMac = hmac.digest().subarray(0, 10);
    if (!equalBytes(calculatedMac, tail)) {
      throw new WhatsAppInboundMediaError("WhatsApp media authentication failed", false);
    }
    verifyFinishedDigest(
      "encrypted SHA-256",
      encryptedHash.digest(),
      options.expectedEncryptedSha256,
    );
    verifyFinishedDigest(
      "plaintext SHA-256",
      plainHash.digest(),
      options.expectedPlainSha256,
    );
    if (options.expectedLength !== null && plainLength !== options.expectedLength) {
      throw new WhatsAppInboundMediaError("WhatsApp media length check failed", false);
    }
    writer.end();
    await once(writer, "finish");
    reader.releaseLock();
    return { path, length: plainLength };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    writer.destroy();
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

function temporaryFileBody(path: string): ReadableStream<Uint8Array> {
  const stream = createReadStream(path);
  const iterator = stream[Symbol.asyncIterator]();
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await unlink(path).catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          await cleanup();
          return;
        }
        const chunk = next.value;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
        stream.destroy();
        await cleanup();
      }
    },
    async cancel(reason) {
      stream.destroy(reason instanceof Error ? reason : undefined);
      await cleanup();
    },
  });
}

export function whatsAppMediaDescriptor(contentType: string): {
  type: AdapterMedia["type"];
  defaultMimeType: string;
  baileysType: MediaType;
} | null {
  switch (contentType) {
    case "imageMessage":
      return { type: "image", defaultMimeType: "image/jpeg", baileysType: "image" };
    case "videoMessage":
      return { type: "video", defaultMimeType: "video/mp4", baileysType: "video" };
    case "ptvMessage":
      return { type: "video", defaultMimeType: "video/mp4", baileysType: "ptv" };
    case "audioMessage":
      return { type: "audio", defaultMimeType: "audio/ogg", baileysType: "audio" };
    case "stickerMessage":
      return { type: "image", defaultMimeType: "image/webp", baileysType: "sticker" };
    case "documentMessage":
      return {
        type: "document",
        defaultMimeType: "application/octet-stream",
        baileysType: "document",
      };
    default:
      return null;
  }
}

export function isWhatsAppDownloadableMediaContentType(contentType: string): boolean {
  return whatsAppMediaDescriptor(contentType) !== null;
}

export function mediaDownloadUrl(
  urlValue: string | null | undefined,
  directPath: string | null | undefined,
): string | null {
  let supplied: URL | undefined;
  if (urlValue) {
    try {
      supplied = new URL(urlValue);
    } catch {
      supplied = undefined;
    }
  }
  const host = supplied?.hostname.endsWith(".whatsapp.net")
    ? supplied.host
    : "mmg.whatsapp.net";
  const candidate = directPath
    ? `https://${host}${directPath}`
    : supplied?.toString();
  if (!candidate) return null;
  return allowedWhatsAppMediaUrl(candidate)?.toString() ?? null;
}

const MAX_MEDIA_REDIRECTS = 3;

export function resolveWhatsAppMediaRedirect(
  current: string | URL,
  location: string,
): URL | null {
  try {
    return allowedWhatsAppMediaUrl(new URL(location, current));
  } catch {
    return null;
  }
}

async function fetchWhatsAppMedia(initialUrl: string): Promise<Response> {
  let url = allowedWhatsAppMediaUrl(initialUrl);
  if (!url) {
    throw new WhatsAppInboundMediaError("WhatsApp media URL is unsafe", false);
  }
  for (let redirects = 0; redirects <= MAX_MEDIA_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Origin: "https://web.whatsapp.com" },
        redirect: "manual",
      });
    } catch (error) {
      throw new WhatsAppInboundMediaError(
        `WhatsApp media transport failed: ${errorMessage(error)}`,
        true,
      );
    }
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    await cancelResponseBody(response, "Following WhatsApp media redirect");
    if (!location || redirects === MAX_MEDIA_REDIRECTS) {
      throw new WhatsAppInboundMediaError("WhatsApp media redirect is invalid", false);
    }
    const redirected = resolveWhatsAppMediaRedirect(url, location);
    if (!redirected) {
      throw new WhatsAppInboundMediaError("WhatsApp media redirect is unsafe", false);
    }
    url = redirected;
  }
  throw new WhatsAppInboundMediaError("WhatsApp media redirect limit exceeded", false);
}

function allowedWhatsAppMediaUrl(value: string | URL): URL | null {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:"
    && url.hostname.endsWith(".whatsapp.net")
    && !url.username
    && !url.password
    && (url.port === "" || url.port === "443")
    ? url
    : null;
}

function verifyFinishedDigest(
  label: string,
  actual: Uint8Array,
  expected: Uint8Array | null | undefined,
): void {
  if (!expected || expected.byteLength === 0) return;
  if (!equalBytes(actual, expected)) {
    throw new WhatsAppInboundMediaError(`WhatsApp media ${label} check failed`, false);
  }
}

function parseContentLength(value: string | null): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(
    Buffer.from(left.buffer, left.byteOffset, left.byteLength),
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );
}

function normalizeByteLength(value: number | bigint | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let serialized: string;
  try {
    serialized = String(value);
  } catch {
    return null;
  }
  if (!/^\d+$/.test(serialized)) return null;
  const parsed = Number(serialized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function classifyMediaError(
  error: Error,
  refreshedMediaUrl = false,
): WhatsAppInboundMediaError {
  if (error instanceof WhatsAppInboundMediaError) return error;
  if (error instanceof MediaHttpError) {
    return new WhatsAppInboundMediaError(
      error.message,
      isRetryableWhatsAppMediaHttpStatus(error.status, refreshedMediaUrl),
    );
  }
  return new WhatsAppInboundMediaError(
    `WhatsApp media download failed: ${errorMessage(error)}`,
    true,
  );
}

export function isRetryableWhatsAppMediaHttpStatus(
  status: number,
  refreshedMediaUrl = false,
): boolean {
  if (status === 404 || status === 410) return !refreshedMediaUrl;
  return status === 408 || status === 429 || status >= 500;
}

export function normalizeWhatsAppMimeType(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = value?.split(";", 1)[0].trim().toLowerCase();
  return normalized
    && normalized.length <= 127
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : fallback;
}

export function normalizeWhatsAppFilename(
  value: string | null | undefined,
): string | undefined {
  const normalized = value
    ?.split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

export function normalizeWhatsAppDuration(
  value: number | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number.isFinite(value) && value >= 0
    ? Math.min(value, 30 * 24 * 60 * 60)
    : undefined;
}
