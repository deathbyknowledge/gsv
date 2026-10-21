import { describe, expect, it } from "vitest";

import {
  DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE,
  DEFAULT_WHATSAPP_TEMPLATE_NAME,
  managedWhatsAppReachNote,
  managedWhatsAppTemplate,
  managedWhatsAppUnreachableCallingCodes,
} from "./managed-config";

describe("managedWhatsAppUnreachableCallingCodes", () => {
  it("keeps a number outside Brazil and Indonesia from both", () => {
    expect(managedWhatsAppUnreachableCallingCodes("+34 600 000 000")).toEqual(["55", "62"]);
    expect(managedWhatsAppReachNote("+34600000000"))
      .toBe("Meta currently blocks this number from messaging WhatsApp numbers in Brazil (+55) and Indonesia (+62), so people there cannot receive the code. If the user may be there, tell them before they try and offer another enabled messenger or email.");
  });

  it("keeps a number inside one of them only from the other", () => {
    expect(managedWhatsAppUnreachableCallingCodes("+55 11 90000-0000")).toEqual(["62"]);
    expect(managedWhatsAppReachNote("+5511900000000")).toContain("in Indonesia (+62), so");
    expect(managedWhatsAppUnreachableCallingCodes("+62 812 0000 0000")).toEqual(["55"]);
    expect(managedWhatsAppReachNote("+628120000000")).toContain("in Brazil (+55), so");
  });
});

describe("managedWhatsAppTemplate", () => {
  it("defaults the template name and language when the operator sets nothing", () => {
    expect(managedWhatsAppTemplate({})).toEqual({
      name: DEFAULT_WHATSAPP_TEMPLATE_NAME,
      language: DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE,
    });
    expect(DEFAULT_WHATSAPP_TEMPLATE_NAME).toBe("gsv_message");
    expect(DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE).toBe("en");
  });

  it("accepts and trims operator values", () => {
    expect(managedWhatsAppTemplate({ WHATSAPP_TEMPLATE_NAME: " gsv_reply ", WHATSAPP_TEMPLATE_LANGUAGE: "pt_BR" }))
      .toEqual({ name: "gsv_reply", language: "pt_BR" });
  });

  it("reads an empty name as templates switched off and rejects values Meta would refuse", () => {
    expect(managedWhatsAppTemplate({ WHATSAPP_TEMPLATE_NAME: "" })).toBeNull();
    expect(managedWhatsAppTemplate({ WHATSAPP_TEMPLATE_NAME: "Bad Name" })).toBeNull();
    expect(managedWhatsAppTemplate({ WHATSAPP_TEMPLATE_LANGUAGE: "english" })).toBeNull();
  });
});
