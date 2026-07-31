import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_QR_TTL_MS,
  initialWhatsAppAccountId,
  isWhatsAppQrImageDataUrl,
  isFreshWhatsAppPairingStatus,
  nextWhatsAppAccountId,
  qrSecondsRemaining,
  whatsappAccountIdError,
  whatsappPairingStatusStartedAt,
  whatsappQrExpiresAt,
  whatsappQrSource,
} from "./whatsappPairing";

describe("WhatsApp pairing model", () => {
  it("chooses a stable unused account ID", () => {
    expect(nextWhatsAppAccountId([])).toBe("default");
    expect(nextWhatsAppAccountId(["default", "account-2"])).toBe("account-3");
  });

  it("preserves the existing account ID for reconnect and relink", () => {
    expect(initialWhatsAppAccountId(" primary-number ", ["default"]))
      .toBe("primary-number");
  });

  it("validates local account handles", () => {
    expect(whatsappAccountIdError("personal-number")).toBe("");
    expect(whatsappAccountIdError("bad account")).toContain("letters");
    expect(whatsappAccountIdError(" ")).toContain("Enter");
    expect(whatsappAccountIdError("default", ["default", "account-2"]))
      .toContain("already exists");
  });

  it("distinguishes raw QR text from rendered image data", () => {
    expect(whatsappQrSource({ type: "qr", data: "secret", format: "raw" })).toEqual({
      kind: "raw",
      value: "secret",
    });
    expect(whatsappQrSource({ type: "qr", data: "legacy-secret" })).toEqual({
      kind: "raw",
      value: "legacy-secret",
    });
    expect(whatsappQrSource({
      type: "qr",
      data: "data:image/png;base64,AAAA",
      format: "raw",
    })).toEqual({
      kind: "raw",
      value: "data:image/png;base64,AAAA",
    });
    expect(whatsappQrSource({
      type: "qr",
      data: "data:image/png;base64,AAAA",
    })).toEqual({
      kind: "data-url",
      value: "data:image/png;base64,AAAA",
    });
    expect(whatsappQrSource({
      type: "qr",
      data: "data:image/png;base64,AAAA",
      format: "data-url",
    })).toEqual({
      kind: "data-url",
      value: "data:image/png;base64,AAAA",
    });
    expect(whatsappQrSource({ type: "qr", data: "not-an-image", format: "data-url" })).toBeNull();
    expect(whatsappQrSource({
      type: "qr",
      data: "data:image/svg+xml,<svg onload='alert(1)'></svg>",
    })).toBeNull();
  });

  it("only accepts base64 raster image data URLs", () => {
    expect(isWhatsAppQrImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isWhatsAppQrImageDataUrl("data:image/jpeg;base64,/9j/AA==")).toBe(true);
    expect(isWhatsAppQrImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isWhatsAppQrImageDataUrl("data:image/png,not-base64")).toBe(false);
    expect(isWhatsAppQrImageDataUrl("data:image/png;base64,AAA")).toBe(false);
  });

  it("honors declared expiry and only falls back when expiry metadata is missing", () => {
    const issuedAt = 1_000_000;
    expect(whatsappQrExpiresAt({ type: "qr", data: "x", expiresAt: issuedAt + 10_000 }, issuedAt))
      .toBe(issuedAt + 10_000);
    expect(whatsappQrExpiresAt({ type: "qr", data: "x", expiresAt: issuedAt - 1 }, issuedAt))
      .toBe(issuedAt - 1);
    expect(whatsappQrExpiresAt({ type: "qr", data: "x" }, issuedAt))
      .toBe(issuedAt + DEFAULT_WHATSAPP_QR_TTL_MS);
    expect(qrSecondsRemaining(issuedAt + 10_001, issuedAt)).toBe(11);
    expect(qrSecondsRemaining(issuedAt, issuedAt + 1)).toBe(0);
  });

  it("uses the connect attempt for reconnect status and the QR issue time for pairing", () => {
    expect(whatsappPairingStatusStartedAt({
      challengeIssuedAt: 0,
      connectAttemptStartedAt: 2_000,
      reconnectExisting: true,
    })).toBe(2_000);
    expect(whatsappPairingStatusStartedAt({
      challengeIssuedAt: 0,
      connectAttemptStartedAt: 2_000,
      reconnectExisting: false,
    })).toBe(0);
    expect(whatsappPairingStatusStartedAt({
      challengeIssuedAt: 3_000,
      connectAttemptStartedAt: 2_000,
      reconnectExisting: true,
    })).toBe(3_000);
  });

  it("only accepts a paired status observed after the active pairing status anchor", () => {
    expect(isFreshWhatsAppPairingStatus({
      authenticated: true,
      connected: true,
      pairingStatusStartedAt: 2_000,
      statusUpdatedAt: 1_999,
    })).toBe(false);
    expect(isFreshWhatsAppPairingStatus({
      authenticated: true,
      connected: true,
      pairingStatusStartedAt: 2_000,
      statusUpdatedAt: 2_000,
    })).toBe(true);
    expect(isFreshWhatsAppPairingStatus({
      authenticated: false,
      connected: true,
      pairingStatusStartedAt: 2_000,
      statusUpdatedAt: 2_001,
    })).toBe(false);
  });

  it("only falls back to a generated suffix after bounded collisions", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const ids = ["default", ...Array.from({ length: 9_998 }, (_, index) => `account-${index + 2}`)];
    expect(nextWhatsAppAccountId(ids)).toBe("account-1234");
    vi.restoreAllMocks();
  });
});
