import { describe, expect, it } from "vitest";
import {
  isPairingLinkMessage,
  messengerSignupUrl,
  pairingLinkCode,
  pairingLinkMessage,
  parsePairingLinkInput,
  shipHost,
} from "../src/pairing-link";

describe("pairing link codes", () => {
  it("reads the code a link prefills, typed by hand or sent by Telegram's Start", () => {
    expect(pairingLinkCode(pairingLinkMessage("ABCDEFGHJKLM"))).toBe("ABCDEFGHJKLM");
    expect(pairingLinkCode("connect my ship abcd-efgh-jklm")).toBe("ABCDEFGHJKLM");
    expect(pairingLinkCode("ABCD-EFGH-JKLM")).toBe("ABCDEFGHJKLM");
    expect(pairingLinkCode("/start ABCDEFGHJKLM")).toBe("ABCDEFGHJKLM");
  });

  it("finds no code in ordinary conversation", () => {
    // Letters the alphabet leaves out, ungrouped words, and longer runs are not codes.
    expect(pairingLinkCode("fine-with-that")).toBeNull();
    expect(pairingLinkCode("ABCD-EFGH-JKL0")).toBeNull();
    expect(pairingLinkCode("ABCDEFGHJKLM")).toBeNull();
    expect(pairingLinkCode("ABCD-EFGH-JKLM-NPQR")).toBeNull();
    expect(pairingLinkCode("/start")).toBeNull();
    expect(pairingLinkCode(`${"word ".repeat(30)}ABCD-EFGH-JKLM`)).toBeNull();
  });

  it("tells a sent link from a code mentioned in other words", () => {
    expect(isPairingLinkMessage("Connect my Ship ABCD-EFGH-JKLM")).toBe(true);
    expect(isPairingLinkMessage("/start ABCDEFGHJKLM")).toBe(true);
    expect(isPairingLinkMessage("my key is ABCD-EFGH-JKLM")).toBe(false);
  });

  it("names a Ship by the host of its address", () => {
    expect(shipHost("https://esteve.ship.space")).toBe("esteve.ship.space");
  });
});

describe("signup for strangers", () => {
  it("sends someone without a Ship to the operator's signup, marked with the messenger they came from", () => {
    expect(messengerSignupUrl("https://signup.gsv.space", "whatsapp")).toBe("https://signup.gsv.space/?utm_source=whatsapp");
    expect(messengerSignupUrl(" https://gsv.space/owner/signup/?utm_campaign=launch&utm_source=ads ", "telegram"))
      .toBe("https://gsv.space/owner/signup/?utm_campaign=launch&utm_source=telegram");
    expect(messengerSignupUrl(undefined, "whatsapp")).toBeUndefined();
    expect(messengerSignupUrl(" ", "whatsapp")).toBeUndefined();
    expect(messengerSignupUrl("http://signup.gsv.space", "whatsapp")).toBeUndefined();
    expect(messengerSignupUrl("signup.gsv.space", "whatsapp")).toBeUndefined();
  });
});

describe("pairing link input", () => {
  const input = { code: "abcd-efgh-jklm", localUid: 1000, canonicalOrigin: "https://space.example.test", expiresAt: Date.now() + 600_000 };

  it("holds a minted code for the calling installation", () => {
    expect(parsePairingLinkInput("installation", input)).toEqual({
      code: "ABCDEFGHJKLM",
      expiresAt: input.expiresAt,
      link: { installationId: "installation", localUid: 1000, canonicalOrigin: "https://space.example.test" },
    });
  });

  it.each([
    { ...input, code: "ABCD-EFGH-JKL0" },
    { ...input, expiresAt: Date.now() - 1 },
    { ...input, expiresAt: Date.now() + 2 * 60 * 60 * 1000 },
    { ...input, localUid: -1 },
    { ...input, canonicalOrigin: "http://space.example.test" },
    { ...input, canonicalOrigin: "https://space.example.test/settings" },
  ])("refuses a code it should not hold: %j", (refused) => {
    expect(() => parsePairingLinkInput("installation", refused)).toThrow();
  });
});
