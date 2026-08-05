import { describe, expect, it } from "vitest";
import {
  base64UrlToBuffer,
  bufferToBase64Url,
  creationOptions,
  registrationResponse,
  requestOptions,
} from "../passkey";

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

  it("decodes passkey enrollment options and serializes attestation bytes", () => {
    const options = creationOptions({
      challenge: "AQID",
      rp: { id: "accounts.gsv.space", name: "GSV" },
      user: {
        id: "BAUG",
        name: "person@example.com",
        displayName: "Person",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      excludeCredentials: [{ id: "BwgJ", type: "public-key" }],
      authenticatorSelection: { userVerification: "required" },
      attestation: "none",
    });
    expect(Array.from(new Uint8Array(options.challenge as ArrayBuffer)))
      .toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(options.user.id as ArrayBuffer)))
      .toEqual([4, 5, 6]);
    expect(Array.from(new Uint8Array(
      options.excludeCredentials![0].id as ArrayBuffer,
    ))).toEqual([7, 8, 9]);

    const serialized = registrationResponse({
      id: "credential-id",
      rawId: Uint8Array.from([10, 11]).buffer,
      response: {
        clientDataJSON: Uint8Array.from([12]).buffer,
        attestationObject: Uint8Array.from([13]).buffer,
        getTransports: () => ["internal"],
      } as AuthenticatorAttestationResponse,
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      type: "public-key",
    } as unknown as PublicKeyCredential);
    expect(serialized).toMatchObject({
      id: "credential-id",
      rawId: "Cgs",
      response: {
        clientDataJSON: "DA",
        attestationObject: "DQ",
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
    });
  });
});
