import { describe, expect, it } from "vitest";

import {
  buildWhatsAppTemplatePayload,
  WHATSAPP_NO_TEMPLATE_ERROR,
  WHATSAPP_TEMPLATE_RELEASE_PAYLOAD,
} from "./whatsapp-template";

describe("buildWhatsAppTemplatePayload", () => {
  it("sends only the notification template and its release button", () => {
    expect(buildWhatsAppTemplatePayload("34611111189", { name: "gsv_message_notification", language: "en" })).toEqual({
      to: "34611111189",
      type: "template",
      template: {
        name: "gsv_message_notification",
        language: { code: "en" },
        components: [
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: WHATSAPP_TEMPLATE_RELEASE_PAYLOAD }],
          },
        ],
      },
    });
    expect(WHATSAPP_NO_TEMPLATE_ERROR).toContain("no template is configured");
    expect(WHATSAPP_NO_TEMPLATE_ERROR).toContain("workers/adapters/whatsapp/README.md");
  });
});
