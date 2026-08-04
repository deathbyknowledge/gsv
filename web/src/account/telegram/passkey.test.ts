import { describe, expect, it } from "vitest";
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  requestOptions,
} from "./passkey";

describe("account passkey transport", () => {
  it("round-trips WebAuthn binary values with base64url encoding", () => {
    const value = Uint8Array.from([0, 1, 2, 253, 254, 255]).buffer;
    expect(bufferToBase64Url(value)).toBe("AAEC_f7_");
    expect(Array.from(new Uint8Array(base64UrlToBuffer("AAEC_f7_"))))
      .toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("decodes the challenge and allowed credential identifiers", () => {
    const options = requestOptions({
      challenge: "AQID",
      rpId: "accounts.gsv.space",
      userVerification: "required",
      allowCredentials: [{
        id: "BAUG",
        type: "public-key",
        transports: ["internal"],
      }],
    });
    expect(Array.from(new Uint8Array(options.challenge as ArrayBuffer)))
      .toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(
      options.allowCredentials![0].id as ArrayBuffer,
    )))
      .toEqual([4, 5, 6]);
    expect(options.rpId).toBe("accounts.gsv.space");
    expect(options.userVerification).toBe("required");
  });

  it("rejects malformed server challenges", () => {
    expect(() => base64UrlToBuffer("not base64url"))
      .toThrow("Passkey challenge is invalid");
  });
});
