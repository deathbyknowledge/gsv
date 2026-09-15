import { describe, expect, it } from "vitest";

import { renderWhatsAppText, splitWhatsAppText } from "./whatsapp-formatting";

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

describe("splitWhatsAppText", () => {
  it("returns short text unchanged and drops empty input", () => {
    expect(splitWhatsAppText("hello")).toEqual(["hello"]);
    expect(splitWhatsAppText("   ")).toEqual([]);
  });

  it("prefers paragraph, then line, then word boundaries", () => {
    const packed = splitWhatsAppText(`${"a".repeat(10)}\n\n${"b".repeat(10)}\n\n${"c".repeat(10)}`, 25);
    expect(packed).toEqual([`${"a".repeat(10)}\n\n${"b".repeat(10)}`, "c".repeat(10)]);
    const paragraphs = splitWhatsAppText(`${"a".repeat(10)}\n\n${"b".repeat(10)}\n${"c".repeat(10)}`, 25);
    expect(paragraphs).toEqual(["a".repeat(10), `${"b".repeat(10)}\n${"c".repeat(10)}`]);
    const lines = splitWhatsAppText(`${"a".repeat(10)}\n${"b".repeat(10)}\n${"c".repeat(10)}`, 25);
    expect(lines).toEqual([`${"a".repeat(10)}\n${"b".repeat(10)}`, "c".repeat(10)]);
    const words = splitWhatsAppText("one two three four five six", 9);
    expect(words).toEqual(["one two", "three", "four five", "six"]);
  });

  it("hard-cuts unbroken text by code point without splitting surrogate pairs", () => {
    const chunks = splitWhatsAppText("😀".repeat(10), 4);
    expect(chunks).toEqual(["😀".repeat(4), "😀".repeat(4), "😀".repeat(2)]);
    expect(chunks.every((chunk) => [...chunk].length <= 4)).toBe(true);
    const long = "x".repeat(4096 * 2 + 5);
    expect(splitWhatsAppText(long).map((chunk) => chunk.length)).toEqual([4096, 4096, 5]);
  });

  it("does not cut early when the only boundary is near the start", () => {
    expect(splitWhatsAppText(`a ${"b".repeat(30)}`, 20)).toEqual([`a ${"b".repeat(18)}`, "b".repeat(12)]);
    expect(splitWhatsAppText(`*Title*\n\n${"word ".repeat(10)}`, 30))
      .toEqual(["*Title*", "word ".repeat(6).trimEnd(), "word ".repeat(4).trimEnd()]);
    expect(splitWhatsAppText(`*T*\n\n${"word ".repeat(10)}`, 30))
      .toEqual([`*T*\n\n${"word ".repeat(5).trimEnd()}`, "word ".repeat(5).trimEnd()]);
  });
});
