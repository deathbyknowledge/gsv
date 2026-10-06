import { describe, expect, it } from "vitest";

import {
  buildWhatsAppTemplatePayload,
  flattenWhatsAppTemplateParameter,
  WHATSAPP_NO_TEMPLATE_ERROR,
  WHATSAPP_TEMPLATE_PARAMETER_LIMIT,
  WHATSAPP_TEMPLATE_RELEASE_PAYLOAD,
} from "./whatsapp-template";

describe("flattenWhatsAppTemplateParameter", () => {
  it("flattens Markdown into one line without markers, newlines, tabs or runs of spaces", () => {
    const flattened = flattenWhatsAppTemplateParameter([
      "# Summary",
      "",
      "Use **bold**, _italic_ and `code`.\tTabbed      spaced",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "See [the docs](https://docs.gsv.space/).",
    ].join("\n"));
    expect(flattened).toEqual({
      text: "Summary · Use bold, italic and code. Tabbed spaced · first; second · const a = 1; · See the docs (https://docs.gsv.space/).",
      complete: true,
    });
    expect(flattened.text).not.toMatch(/[\n\t]| {5}/);
  });

  it("cuts an oversized message at a word boundary with an ellipsis and reports it incomplete", () => {
    const long = "word ".repeat(400).trimEnd();
    const flattened = flattenWhatsAppTemplateParameter(long, 100);
    expect(flattened.complete).toBe(false);
    expect([...flattened.text].length).toBeLessThanOrEqual(100);
    expect(flattened.text).toMatch(/^word( word)*…$/);
    expect([...flattenWhatsAppTemplateParameter(long).text].length)
      .toBeLessThanOrEqual(WHATSAPP_TEMPLATE_PARAMETER_LIMIT);
  });

  it("never produces an empty parameter", () => {
    expect(flattenWhatsAppTemplateParameter("---")).toEqual({ text: "You have a new message.", complete: false });
    expect(flattenWhatsAppTemplateParameter("   ")).toEqual({ text: "You have a new message.", complete: false });
  });
});

describe("buildWhatsAppTemplatePayload", () => {
  it("names the template, fills the body parameter and binds the release payload to the button", () => {
    expect(buildWhatsAppTemplatePayload("34611111189", { name: "gsv_message", language: "en" }, "late follow-up")).toEqual({
      to: "34611111189",
      type: "template",
      template: {
        name: "gsv_message",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "late follow-up" }] },
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
