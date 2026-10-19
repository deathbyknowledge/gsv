import { describe, expect, it } from "vitest";

import {
  buildWhatsAppTemplatePayload,
  WHATSAPP_NO_TEMPLATE_ERROR,
  WHATSAPP_TEMPLATE_BODY,
  WHATSAPP_TEMPLATE_REPLY_PAYLOAD,
} from "./whatsapp-template";

describe("buildWhatsAppTemplatePayload", () => {
  it("carries the actual message and a reply button", () => {
    expect(buildWhatsAppTemplatePayload("34611111189", { name: "gsv_message", language: "en" }, "Your report is ready.")).toEqual({
      to: "34611111189",
      type: "template",
      template: {
        name: "gsv_message",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Your report is ready." }] },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: WHATSAPP_TEMPLATE_REPLY_PAYLOAD }],
          },
        ],
      },
    });
    expect(WHATSAPP_NO_TEMPLATE_ERROR).toContain("no template is configured");
    expect(WHATSAPP_NO_TEMPLATE_ERROR).toContain("workers/adapters/whatsapp/README.md");
  });

  it("flattens paragraphs and retains links in a template parameter", () => {
    const payload = buildWhatsAppTemplatePayload("1", { name: "gsv_message", language: "en" }, "First paragraph.\n\nRead [the report](https://example.com/report).\tDone.");
    expect(payload.template?.components?.[0]?.parameters).toEqual([
      { type: "text", text: "First paragraph. · Read the report (https://example.com/report). Done." },
    ]);
  });

  it.each(["x", "🌍"])("bounds a long preview including the template frame (%s)", (character) => {
    const payload = buildWhatsAppTemplatePayload("1", { name: "gsv_message", language: "en" }, character.repeat(2000));
    const parameter = payload.template?.components?.[0]?.parameters?.[0];
    if (parameter?.type !== "text") throw new Error("Missing text parameter");
    const text = parameter.text!;
    expect(text).toContain("Open GSV for the full message.");
    expect([...WHATSAPP_TEMPLATE_BODY.replace("{{1}}", text)]).toHaveLength(1024);
    expect(text).not.toMatch(/[\r\n\t]|�/);
  });
});
