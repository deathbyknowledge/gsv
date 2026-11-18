import { describe, expect, it } from "vitest";
import {
  answersLinkMove,
  keepsLink,
  platformReplies,
  replyLanguageFromCountry,
  replyLanguageFromPhoneNumber,
  replyLanguageFromTag,
} from "../src/platform-replies";

describe("reply language", () => {
  it("follows an app's language tag, reading Spain's other languages as Spanish", () => {
    expect(replyLanguageFromTag("es")).toBe("es");
    expect(replyLanguageFromTag("es-MX")).toBe("es");
    expect(replyLanguageFromTag("ca")).toBe("es");
    expect(replyLanguageFromTag("pt-br")).toBe("pt");
    expect(replyLanguageFromTag("PT")).toBe("pt");
    expect(replyLanguageFromTag("en")).toBe("en");
    expect(replyLanguageFromTag("nl")).toBe("en");
    expect(replyLanguageFromTag(undefined)).toBe("en");
  });

  it("follows a number's calling code or a country code", () => {
    expect(replyLanguageFromPhoneNumber("34611111189")).toBe("es");
    expect(replyLanguageFromPhoneNumber("376312345")).toBe("es");
    expect(replyLanguageFromPhoneNumber("5215512345678")).toBe("es");
    expect(replyLanguageFromPhoneNumber("351912345678")).toBe("pt");
    expect(replyLanguageFromPhoneNumber("5511912345678")).toBe("pt");
    expect(replyLanguageFromPhoneNumber("31612345678")).toBe("en");
    expect(replyLanguageFromPhoneNumber("13213604274")).toBe("en");
    expect(replyLanguageFromCountry("ES")).toBe("es");
    expect(replyLanguageFromCountry("pt")).toBe("pt");
    expect(replyLanguageFromCountry("US")).toBe("en");
  });
});

describe("platform replies", () => {
  it("tells an unlinked sender how to create a Ship when signup is open, and what to tell a Ship either way", () => {
    const text = platformReplies("WhatsApp", "en");
    // The address stands on its own line, so no messenger takes punctuation into the link.
    expect(text.unlinked("https://signup.ship.space/?utm_source=whatsapp")).toBe([
      "Hi! To create your Ship, click on this link:",
      "https://signup.ship.space/?utm_source=whatsapp",
      "",
      "Already have a Ship? Just tell it “connect my WhatsApp” and it will send you a link.",
    ].join("\n"));
    expect(text.unlinked()).toBe("To talk to your Ship here, tell it “connect my WhatsApp” and it will send you a link.");
  });

  it("speaks Spanish and Portuguese with the link on its own line", () => {
    expect(platformReplies("Telegram", "es").unlinked("https://ship.space/owner/signup/")).toBe([
      "¡Hola! Para crear tu Ship, entra en este enlace:",
      "https://ship.space/owner/signup/",
      "",
      "¿Ya tienes un Ship? Solo dile “conecta mi Telegram” y te enviará un enlace.",
    ].join("\n"));
    expect(platformReplies("WhatsApp", "pt").unlinked("https://ship.space/owner/signup/")).toBe([
      "Olá! Para criar o seu Ship, abra este link:",
      "https://ship.space/owner/signup/",
      "",
      "Já tem um Ship? É só enviar “conectar o meu WhatsApp” ao seu Ship e ele responde com um link.",
    ].join("\n"));
    expect(platformReplies("WhatsApp", "es").unsupported).toContain("una nota de voz o una ubicación");
    expect(platformReplies("Telegram", "es").unsupported).toContain("archivo adjunto compatible");
  });

  it("takes the move answers in any reply language, only while the question is open", () => {
    const move = { expiresAt: 2_000 };
    for (const language of ["en", "es", "pt"] as const) {
      const [moveIt, keepIt] = platformReplies("Telegram", language).moveChoices;
      expect(answersLinkMove(move, moveIt, 1_000)).toBe(true);
      expect(answersLinkMove(move, keepIt, 1_000)).toBe(true);
      expect(keepsLink(moveIt)).toBe(false);
      expect(keepsLink(keepIt)).toBe(true);
    }
    expect(answersLinkMove(move, "move it", 1_000)).toBe(false);
    expect(answersLinkMove(move, "Move it", 2_000)).toBe(false);
    expect(answersLinkMove(undefined, "Move it", 1_000)).toBe(false);
  });
});
