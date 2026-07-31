import { describe, expect, it, vi } from "vitest";

import {
  baileysEncryptionFailureFields,
  quietBaileysLogger,
} from "../src/baileys-logger";
import { errorFields, errorMessage } from "../src/logging";

describe("WhatsApp Baileys logger", () => {
  it("reports only structured fields for a recipient-encryption failure", () => {
    const encryptionError = Object.assign(new RangeError(
      "No session for 12025550123@s.whatsapp.net token=secret",
    ), { statusCode: 500 });
    encryptionError.name = "PrivateProviderError";
    const fields = baileysEncryptionFailureFields({
      jid: "12025550123@s.whatsapp.net",
      err: encryptionError,
    }, "Failed to encrypt for recipient");

    expect(fields).toEqual({
      errorType: "RangeError",
      statusCode: 500,
    });
    expect(JSON.stringify(fields)).not.toContain("12025550123");
    expect(JSON.stringify(fields)).not.toContain("secret");
    expect(baileysEncryptionFailureFields(
      new Error("private provider detail"),
      "unrelated error",
    )).toBeNull();
  });

  it("emits one content-free structured warning and ignores other Baileys logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const encryptionError = new Error(
      "No session for +34 675 706 329 authorization: Bearer private-token",
    );
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
      errorType: "Error",
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

  it("redacts formatted identities and colon-delimited credentials", () => {
    const sanitized = errorMessage(new Error(
      "failed for +34 675-706-329 authorization: Bearer abc123 private key: xyz987",
    ));

    expect(sanitized).not.toMatch(/675|706|329|abc123|xyz987/);
  });
});
