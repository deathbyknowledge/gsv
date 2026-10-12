import { describe, expect, it } from "vitest";

import {
  DEFAULT_WHATSAPP_TEMPLATE_LANGUAGE,
  DEFAULT_WHATSAPP_TEMPLATE_NAME,
  managedWhatsAppTemplate,
} from "./managed-config";

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
