import { describe, expect, it } from "vitest";
import { whatsAppReplyLanguage } from "./whatsapp-address";

describe("whatsAppReplyLanguage", () => {
  it("reads the country from a number or from the prefix of a user ID", () => {
    expect(whatsAppReplyLanguage("34611111189")).toBe("es");
    expect(whatsAppReplyLanguage("351912345678")).toBe("pt");
    expect(whatsAppReplyLanguage("31612345678")).toBe("en");
    expect(whatsAppReplyLanguage("ES.55555555555555555555")).toBe("es");
    expect(whatsAppReplyLanguage("BR.13491208655302741918")).toBe("pt");
    expect(whatsAppReplyLanguage("US.13491208655302741918")).toBe("en");
  });
});
