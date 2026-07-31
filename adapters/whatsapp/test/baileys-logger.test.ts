import { describe, expect, it, vi } from "vitest";

import { quietBaileysLogger } from "../src/baileys-logger";
import { errorFields, errorMessage } from "../src/logging";

describe("WhatsApp Baileys logger", () => {
  it("emits one content-free structured warning and ignores other Baileys logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const encryptionError = Object.assign(new RangeError(
      "No session for +34 675 706 329 authorization: Bearer private-token",
    ), { statusCode: 500 });
    encryptionError.name = "Recipient-12025550123";

    quietBaileysLogger.error({
      jid: "12025550123@s.whatsapp.net",
      err: encryptionError,
    }, "Failed to encrypt for recipient");
    quietBaileysLogger.error(
      new Error("private provider detail"),
      "unrelated error",
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      adapter: "whatsapp",
      event: "baileys_recipient_encryption_failed",
      errorType: "RangeError",
      statusCode: 500,
    });
    expect(String(warn.mock.calls[0][0])).not.toMatch(
      /12025550123|675 706 329|private-token|provider detail/,
    );
  });
});

describe("WhatsApp error hygiene", () => {
  it("allowlists error types and HTTP status codes", () => {
    const privateError = Object.assign(new Error("private"), {
      name: "SecretAccountError",
      statusCode: 12025550123,
    });

    expect(errorFields(privateError)).toEqual({ errorType: "Error" });
    expect(errorFields({ status: 429 })).toEqual({
      errorType: "object",
      statusCode: 429,
    });
  });

  it("redacts public error details and bounds their length", () => {
    const sanitized = errorMessage(new Error(
      `failed https://example.com/path?token=secret for +34 675-706-329 `
      + `authorization: Bearer abc123 private key: xyz987 `
      + `authorization=BearerSecret 12025550123@s.whatsapp.net ${"A".repeat(1_000)}`,
    ));

    expect(sanitized).not.toMatch(
      /example\.com|675|706|329|abc123|xyz987|BearerSecret|12025550123/,
    );
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });
});
