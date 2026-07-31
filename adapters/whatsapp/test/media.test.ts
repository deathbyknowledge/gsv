import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  getMediaKeys,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadWhatsAppMedia,
  isRetryableWhatsAppMediaHttpStatus,
  isWhatsAppDownloadableMediaContentType,
  MAX_WHATSAPP_MEDIA_BYTES,
  MAX_WHATSAPP_MEDIA_TOTAL_BYTES,
  mediaDownloadUrl,
  normalizeWhatsAppDuration,
  normalizeWhatsAppFilename,
  normalizeWhatsAppMimeType,
  resolveWhatsAppMediaRedirect,
  whatsAppMediaDescriptor,
} from "../src/media";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WhatsApp media descriptors", () => {
  it("keeps sticker and PTV support in the downloadable descriptor source", () => {
    expect(whatsAppMediaDescriptor("stickerMessage")).toEqual({
      type: "image",
      defaultMimeType: "image/webp",
      baileysType: "sticker",
    });
    expect(whatsAppMediaDescriptor("ptvMessage")).toEqual({
      type: "video",
      defaultMimeType: "video/mp4",
      baileysType: "ptv",
    });
    expect(isWhatsAppDownloadableMediaContentType("stickerMessage")).toBe(true);
    expect(isWhatsAppDownloadableMediaContentType("locationMessage")).toBe(false);
  });

  it("bounds hostile provider media metadata", () => {
    expect(MAX_WHATSAPP_MEDIA_TOTAL_BYTES)
      .toBeLessThanOrEqual(MAX_WHATSAPP_MEDIA_BYTES / 2);
    expect(normalizeWhatsAppMimeType(
      `text/plain\u0000${"x".repeat(500)}`,
      "application/octet-stream",
    )).toBe("application/octet-stream");
    expect(normalizeWhatsAppFilename(`  report\u0000\n${"x".repeat(500)}.pdf  `))
      .toHaveLength(240);
    expect(normalizeWhatsAppDuration(-1)).toBeUndefined();
    expect(normalizeWhatsAppDuration(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeWhatsAppDuration(99_999_999)).toBe(30 * 24 * 60 * 60);
  });
});

describe("WhatsApp media URL policy", () => {
  it("allows only authenticated HTTPS WhatsApp CDN hosts", () => {
    expect(mediaDownloadUrl("https://mmg.whatsapp.net/file", undefined))
      .toBe("https://mmg.whatsapp.net/file");
    expect(mediaDownloadUrl("https://evil.example/file", undefined)).toBeNull();
    expect(mediaDownloadUrl("http://mmg.whatsapp.net/file", undefined)).toBeNull();
    expect(mediaDownloadUrl("https://user:pass@mmg.whatsapp.net/file", undefined))
      .toBeNull();
  });

  it("revalidates relative and absolute redirect destinations", () => {
    expect(resolveWhatsAppMediaRedirect(
      "https://mmg.whatsapp.net/a",
      "/b",
    )?.toString()).toBe("https://mmg.whatsapp.net/b");
    expect(resolveWhatsAppMediaRedirect(
      "https://mmg.whatsapp.net/a",
      "https://cdn.whatsapp.net/b",
    )?.toString()).toBe("https://cdn.whatsapp.net/b");
    expect(resolveWhatsAppMediaRedirect(
      "https://mmg.whatsapp.net/a",
      "https://evil.example/b",
    )).toBeNull();
    expect(resolveWhatsAppMediaRedirect(
      "https://mmg.whatsapp.net/a",
      "http://cdn.whatsapp.net/b",
    )).toBeNull();
  });

  it("bounds provider redirects and rejects the fourth hop", async () => {
    const fixture = await encryptedImageFixture();
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, {
      status: 302,
      headers: { Location: "/next" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadWhatsAppMedia(stubSocket(), fixture.message)).rejects
      .toMatchObject({ retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual" });
      expect(new Headers(call[1]?.headers).get("origin"))
        .toBe("https://web.whatsapp.com");
    }
  });
});

describe("WhatsApp media integrity", () => {
  it("streams authenticated media to an owned body", async () => {
    const fixture = await encryptedImageFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fixture.encrypted, {
      headers: { "Content-Length": String(fixture.encrypted.byteLength) },
    })));

    const part = await downloadWhatsAppMedia(stubSocket(), fixture.message);
    expect(part?.media).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      size: fixture.plain.byteLength,
    });
    expect(Buffer.from(await new Response(part!.body!.stream).arrayBuffer()))
      .toEqual(fixture.plain);
  });

  it("treats authentication and decryption failures as permanent", async () => {
    const fixture = await encryptedImageFixture();
    const corrupted = Buffer.from(fixture.encrypted);
    corrupted[corrupted.byteLength - 1] ^= 0xff;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(corrupted)));

    await expect(downloadWhatsAppMedia(stubSocket(), fixture.message)).rejects
      .toEqual(expect.objectContaining({
        name: "WhatsAppInboundMediaError",
        retryable: false,
      }));
  });

  it("derives and validates media keys before opening a response", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message = {
      key: { id: "missing-key", remoteJid: "12025550123@s.whatsapp.net" },
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/file",
          mimetype: "image/jpeg",
        },
      },
    } as WAMessage;

    await expect(downloadWhatsAppMedia(stubSocket(), message)).rejects
      .toMatchObject({ retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops retrying an expired URL after one provider refresh", async () => {
    const fixture = await encryptedImageFixture();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const updateMediaMessage = vi.fn(async () => fixture.message);

    await expect(downloadWhatsAppMedia(
      stubSocket(updateMediaMessage),
      fixture.message,
    )).rejects.toMatchObject({ retryable: false });
    expect(updateMediaMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps transient HTTP failures retryable", () => {
    expect(isRetryableWhatsAppMediaHttpStatus(408, true)).toBe(true);
    expect(isRetryableWhatsAppMediaHttpStatus(429, true)).toBe(true);
    expect(isRetryableWhatsAppMediaHttpStatus(503, true)).toBe(true);
    expect(isRetryableWhatsAppMediaHttpStatus(404, true)).toBe(false);
    expect(isRetryableWhatsAppMediaHttpStatus(410, false)).toBe(true);
  });
});

async function encryptedImageFixture(): Promise<{
  plain: Buffer;
  encrypted: Buffer;
  message: WAMessage;
}> {
  const plain = Buffer.from("authenticated WhatsApp media fixture");
  const mediaKey = randomBytes(32);
  const keys = await getMediaKeys(mediaKey, "image");
  if (!keys.macKey) throw new Error("Fixture did not derive a MAC key");
  const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac("sha256", keys.macKey)
    .update(keys.iv)
    .update(ciphertext)
    .digest()
    .subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  return {
    plain,
    encrypted,
    message: {
      key: { id: "media-1", remoteJid: "12025550123@s.whatsapp.net" },
      message: {
        imageMessage: {
          url: "https://mmg.whatsapp.net/file",
          mediaKey,
          mimetype: "image/jpeg",
          fileLength: plain.byteLength,
          fileSha256: createHash("sha256").update(plain).digest(),
          fileEncSha256: createHash("sha256").update(encrypted).digest(),
        },
      },
    } as WAMessage,
  };
}

function stubSocket(
  updateMediaMessage: (message: WAMessage) => Promise<WAMessage> = async (message) => message,
): WASocket {
  return { updateMediaMessage } as unknown as WASocket;
}
