import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";

import { formatWhatsAppText } from "../src/formatting";
import { whatsAppFallbackText } from "../src/inbound";
import { errorMessage } from "../src/logging";
import {
  defaultWhatsAppFilename,
  planWhatsAppOutboundDeliveries,
} from "../src/outbound";
import type { AdapterMedia } from "../../shared/src/types";

const image: AdapterMedia = { type: "image", mimeType: "image/jpeg" };
const audio: AdapterMedia = { type: "audio", mimeType: "audio/ogg" };
const document: AdapterMedia = { type: "document", mimeType: "application/pdf" };

describe("WhatsApp outbound behavior", () => {
  it("uses the first caption-capable attachment for text", () => {
    expect(planWhatsAppOutboundDeliveries(" Result ", [image, document])).toEqual([
      { kind: "media", mediaIndex: 0, caption: "Result" },
      { kind: "media", mediaIndex: 1, caption: "" },
    ]);
  });

  it("keeps text when the first attachment is audio", () => {
    expect(planWhatsAppOutboundDeliveries("Listen", [audio, image])).toEqual([
      { kind: "text", text: "Listen" },
      { kind: "media", mediaIndex: 0, caption: "" },
      { kind: "media", mediaIndex: 1, caption: "" },
    ]);
  });

  it("normalizes filenames and WhatsApp markup", () => {
    expect(defaultWhatsAppFilename(document)).toBe("attachment.pdf");
    expect(defaultWhatsAppFilename({ ...document, filename: ` ${"x".repeat(300)} ` }))
      .toHaveLength(240);
    expect(formatWhatsAppText(
      "# Heading\n**bold** and `**literal**` [docs](https://example.com)",
    )).toBe(
      "*Heading*\n*bold* and `**literal**` docs (https://example.com)",
    );
  });
});

describe("WhatsApp inbound fallbacks", () => {
  it("preserves common non-text payloads as safe text", () => {
    expect(whatsAppFallbackText(proto.Message.create({
      locationMessage: {
        name: "Office",
        degreesLatitude: 52.3676,
        degreesLongitude: 4.9041,
      },
    }), "locationMessage")).toBe("[Location: Office] (52.367600, 4.904100)");
    expect(whatsAppFallbackText(proto.Message.create({
      contactMessage: { displayName: "Ada Lovelace", vcard: "private-vcard" },
    }), "contactMessage")).toBe("[Contact: Ada Lovelace]");
    expect(whatsAppFallbackText(proto.Message.create({
      reactionMessage: { text: "👍" },
    }), "reactionMessage")).toBe("[Reaction: 👍]");
    expect(whatsAppFallbackText(proto.Message.create({
      pollCreationMessage: {
        name: "Lunch?",
        options: [{ optionName: "Soup" }, { optionName: "Salad" }],
      },
    }), "pollCreationMessage")).toBe("[Poll: Lunch?]\n- Soup\n- Salad");
  });

  it("ignores transport-only protocol records", () => {
    expect(whatsAppFallbackText(
      proto.Message.create({ protocolMessage: { type: 0 } }),
      "protocolMessage",
    )).toBeUndefined();
  });
});

describe("WhatsApp public error hygiene", () => {
  it("redacts URLs, secrets, JIDs, and long payloads", () => {
    const sanitized = errorMessage(new Error(
      `failed https://example.com/path?token=secret authorization=BearerSecret `
      + `12025550123@s.whatsapp.net ${"A".repeat(1_000)}`,
    ));
    expect(sanitized).not.toContain("example.com");
    expect(sanitized).not.toContain("BearerSecret");
    expect(sanitized).not.toContain("12025550123");
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });
});
