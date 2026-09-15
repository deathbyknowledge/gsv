import { describe, expect, it } from "vitest";

import {
  renderWhatsAppText,
  WHATSAPP_TEXT_LIMIT,
  whatsAppPromptMessages,
  whatsAppTextMessages,
} from "./whatsapp-formatting";

describe("renderWhatsAppText", () => {
  it("renders common agent Markdown with WhatsApp markers", () => {
    const text = renderWhatsAppText([
      "# Summary",
      "",
      "Use **bold**, _italic_, ~~old~~, and `x < y`.",
      "",
      "- first",
      "- [x] done",
      "",
      "1. one",
      "2. two",
      "",
      "> quoted",
      "",
      "```ts",
      "const value = 1 < 2;",
      "```",
      "",
      "See [the docs](https://docs.gsv.space/) or https://gsv.space/.",
    ].join("\n"));

    expect(text).toContain("*Summary*");
    expect(text).toContain("*bold*");
    expect(text).toContain("_italic_");
    expect(text).toContain("~old~");
    expect(text).toContain("`x < y`");
    expect(text).toContain("- first");
    expect(text).toContain("☑ done");
    expect(text).toContain("1. one\n2. two");
    expect(text).toContain("> quoted");
    expect(text).toContain("```\nconst value = 1 < 2;\n```");
    expect(text).toContain("the docs (https://docs.gsv.space/)");
    expect(text).toContain("https://gsv.space/");
    expect(text).not.toContain("**");
    expect(text).not.toContain("language-ts");
  });

  it("keeps markers touching their text and leaves unsafe links as labels", () => {
    expect(renderWhatsAppText("a ** bold ** b")).toBe("a ** bold ** b");
    expect(renderWhatsAppText("**bold**  then")).toBe("*bold*  then");
    expect(renderWhatsAppText("[click](javascript:alert(1))")).toBe("click");
    expect(renderWhatsAppText("[](https://example.com/)")).toBe("https://example.com/");
    expect(renderWhatsAppText("   ")).toBe("");
  });

  it("flattens tables into readable rows", () => {
    expect(renderWhatsAppText(["| Name | Value |", "| --- | --- |", "| **one** | 1 |"].join("\n")))
      .toBe("*Name | Value*\n*one* | 1");
  });
});

describe("whatsAppTextMessages", () => {
  it("keeps a short reply as one rendered message and drops empty input", () => {
    expect(whatsAppTextMessages("Hi!\n\nDid the **deploy** finish?")).toEqual(["Hi!\n\nDid the *deploy* finish?"]);
    expect(whatsAppTextMessages("   ")).toEqual([]);
  });

  it("sends each long paragraph as its own message within Meta's limit", () => {
    const paragraph = "word ".repeat(80).trimEnd();
    expect(whatsAppTextMessages(`${paragraph}\n\n${paragraph}\n\nBye.`)).toEqual([paragraph, paragraph, "Bye."]);
    const messages = whatsAppTextMessages(`**Report**\n\n${"word ".repeat(1_000)}`);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/^\*Report\*\n\nword word/);
    expect(messages[1]).toMatch(/^word word/);
    expect(messages.every((message) => [...message].length <= WHATSAPP_TEXT_LIMIT)).toBe(true);
  });

  it("keeps a code block whole and re-renders pieces of an oversized paragraph", () => {
    const code = "```\nconst a = 1;\n\nconst b = 2;\n```";
    expect(whatsAppTextMessages(`${"x".repeat(400)}\n\n${code}`)).toEqual(["x".repeat(400), code]);
    const oversized = Array.from({ length: 700 }, (_, index) => `**w${index}**`).join(" ");
    const messages = whatsAppTextMessages(oversized);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => [...message].length <= WHATSAPP_TEXT_LIMIT)).toBe(true);
    expect(messages.every((message) => /^(\*w\d+\*)( \*w\d+\*)*$/.test(message))).toBe(true);
  });
});

describe("whatsAppPromptMessages", () => {
  const prompt = "I need your confirmation before I can continue.\n\nRequested action: run \"date\".";

  it("keeps an ordinary approval prompt as one message", () => {
    expect(whatsAppPromptMessages(prompt, 1024)).toEqual([prompt]);
  });

  it("splits a prompt that exceeds the limit so the last message can carry the buttons", () => {
    const messages = whatsAppPromptMessages(prompt, 48);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => [...message].length <= 48)).toBe(true);
    expect(messages.at(-1)).toMatch(/"date"\.$/);
    expect(messages.join(" ").replace(/\s+/g, " ")).toBe(prompt.replace(/\s+/g, " "));
  });
});
