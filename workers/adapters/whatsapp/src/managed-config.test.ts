import { describe, expect, it } from "vitest";

import {
  DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE,
  DEFAULT_WHATSAPP_TEMPLATE_NAME,
  managedWhatsAppTemplate,
  managedWhatsAppUnreachableCallingCodes,
} from "./managed-config";

describe("managedWhatsAppUnreachableCallingCodes", () => {
  it("keeps a number outside Brazil and Indonesia from both", () => {
    expect(managedWhatsAppUnreachableCallingCodes({ WHATSAPP_DISPLAY_NUMBER: "+34 600 000 000" })).toEqual(["55", "62"]);
  });

  it("keeps a number inside one of them only from the other", () => {
    expect(managedWhatsAppUnreachableCallingCodes({ WHATSAPP_DISPLAY_NUMBER: "+55 11 90000-0000" })).toEqual(["62"]);
    expect(managedWhatsAppUnreachableCallingCodes({ WHATSAPP_DISPLAY_NUMBER: "+62 812 0000 0000" })).toEqual(["55"]);
  });

  it("lets the operator state Meta's record instead", () => {
    const env = { WHATSAPP_DISPLAY_NUMBER: "+34600000000", WHATSAPP_UNREACHABLE_CALLING_CODES: " +62, 55 ,62, " };
    expect(managedWhatsAppUnreachableCallingCodes(env)).toEqual(["62", "55"]);
    const unlocked = { WHATSAPP_DISPLAY_NUMBER: "+34600000000", WHATSAPP_UNREACHABLE_CALLING_CODES: "" };
    expect(managedWhatsAppUnreachableCallingCodes(unlocked)).toEqual([]);
  });

  it("keeps the default rule when the override is malformed", () => {
    for (const value of ["6x", "55, bad", "+", "1234"]) {
      expect(managedWhatsAppUnreachableCallingCodes({ WHATSAPP_DISPLAY_NUMBER: "+34600000000", WHATSAPP_UNREACHABLE_CALLING_CODES: value }))
        .toEqual(["55", "62"]);
      expect(managedWhatsAppUnreachableCallingCodes({ WHATSAPP_DISPLAY_NUMBER: "+5511900000000", WHATSAPP_UNREACHABLE_CALLING_CODES: value }))
        .toEqual(["62"]);
    }
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
