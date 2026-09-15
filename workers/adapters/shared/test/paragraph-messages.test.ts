import { describe, expect, it } from "vitest";

import {
  codePointLength,
  fitMarkdownToLimit,
  SHORT_MESSAGE_THRESHOLD,
  splitMarkdownParagraphs,
  splitTextAtLimit,
} from "../src/paragraph-messages";

const LONG = "word ".repeat(80).trim();

describe("splitMarkdownParagraphs", () => {
  it("splits long paragraphs at blank lines and drops empty input", () => {
    expect(splitMarkdownParagraphs(`${LONG}\n\n${LONG}\n\n${LONG}`)).toEqual([LONG, LONG, LONG]);
    expect(splitMarkdownParagraphs("   \n\n  ")).toEqual([]);
    expect(splitMarkdownParagraphs("one line")).toEqual(["one line"]);
  });

  it("keeps a greeting with the short question that follows it", () => {
    expect(splitMarkdownParagraphs("Hi John!\n\nDid the deploy finish?")).toEqual([
      "Hi John!\n\nDid the deploy finish?",
    ]);
  });

  it("keeps a heading or intro with the paragraph it introduces and closes after it", () => {
    const messages = splitMarkdownParagraphs(`# Report\n\n${LONG}\n\nAnything else?`);
    expect(messages).toEqual([`# Report\n\n${LONG}`, "Anything else?"]);
    expect(codePointLength(messages[0]!)).toBeGreaterThan(SHORT_MESSAGE_THRESHOLD);
  });

  it("merges runs of short paragraphs until the message reaches the threshold", () => {
    const short = "x".repeat(100);
    const messages = splitMarkdownParagraphs(Array.from({ length: 7 }, () => short).join("\n\n"));
    expect(messages).toEqual([
      [short, short, short, short].join("\n\n"),
      [short, short, short].join("\n\n"),
    ]);
  });

  it("keeps fenced code blocks, loose lists, tables and block quotes whole", () => {
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    const list = Array.from({ length: 40 }, (_, index) => `- item ${index}`).join("\n\n");
    const table = "| Name | Value |\n| --- | --- |\n| one | 1 |";
    const quote = "> quoted\n>\n> still quoted";
    const input = `${LONG}\n\n${code}\n\n${LONG}\n\n${list}\n\n${table}\n\n${LONG}\n\n${quote}`;
    const messages = splitMarkdownParagraphs(input);
    expect(messages.join("\n\n")).toBe(input);
    for (const block of [code, list, table, quote]) {
      expect(messages.filter((message) => message.includes(block))).toHaveLength(1);
    }
    // Short blocks join the paragraph after them; the loose list is long enough
    // to stand alone even though blank lines separate its items.
    expect(messages).toEqual([LONG, `${code}\n\n${LONG}`, list, `${table}\n\n${LONG}`, quote]);
  });

  it("preserves indentation that makes a code block", () => {
    const indented = "    line one\n    line two";
    expect(splitMarkdownParagraphs(`${LONG}\n\n${indented}`)).toEqual([LONG, indented]);
  });
});

describe("splitTextAtLimit", () => {
  it("returns short text unchanged and drops empty input", () => {
    expect(splitTextAtLimit("hello", 10)).toEqual(["hello"]);
    expect(splitTextAtLimit("   ", 10)).toEqual([]);
    expect(() => splitTextAtLimit("x", 0)).toThrow("limit is invalid");
  });

  it("prefers paragraph, then line, then word boundaries", () => {
    const packed = splitTextAtLimit(`${"a".repeat(10)}\n\n${"b".repeat(10)}\n\n${"c".repeat(10)}`, 25);
    expect(packed).toEqual([`${"a".repeat(10)}\n\n${"b".repeat(10)}`, "c".repeat(10)]);
    const paragraphs = splitTextAtLimit(`${"a".repeat(10)}\n\n${"b".repeat(10)}\n${"c".repeat(10)}`, 25);
    expect(paragraphs).toEqual(["a".repeat(10), `${"b".repeat(10)}\n${"c".repeat(10)}`]);
    const lines = splitTextAtLimit(`${"a".repeat(10)}\n${"b".repeat(10)}\n${"c".repeat(10)}`, 25);
    expect(lines).toEqual([`${"a".repeat(10)}\n${"b".repeat(10)}`, "c".repeat(10)]);
    const words = splitTextAtLimit("one two three four five six", 9);
    expect(words).toEqual(["one two", "three", "four five", "six"]);
  });

  it("hard-cuts unbroken text by code point without splitting surrogate pairs", () => {
    const pieces = splitTextAtLimit("😀".repeat(10), 4);
    expect(pieces).toEqual(["😀".repeat(4), "😀".repeat(4), "😀".repeat(2)]);
    expect(pieces.every((piece) => codePointLength(piece) <= 4)).toBe(true);
    const long = "x".repeat(4096 * 2 + 5);
    expect(splitTextAtLimit(long, 4096).map((piece) => piece.length)).toEqual([4096, 4096, 5]);
  });

  it("does not cut early when the only boundary is near the start", () => {
    expect(splitTextAtLimit(`a ${"b".repeat(30)}`, 20)).toEqual([`a ${"b".repeat(18)}`, "b".repeat(12)]);
    expect(splitTextAtLimit(`*Title*\n\n${"word ".repeat(10)}`, 30))
      .toEqual(["*Title*", "word ".repeat(6).trimEnd(), "word ".repeat(4).trimEnd()]);
    expect(splitTextAtLimit(`*T*\n\n${"word ".repeat(10)}`, 30))
      .toEqual([`*T*\n\n${"word ".repeat(5).trimEnd()}`, "word ".repeat(5).trimEnd()]);
  });
});

describe("fitMarkdownToLimit", () => {
  const html = (markdown: string): string => markdown
    .replace(/&/g, "&amp;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  it("returns one rendered message when both the Markdown and its rendering fit", () => {
    expect(fitMarkdownToLimit("**hi** there", html, 64)).toEqual([
      { markdown: "**hi** there", rendered: "<b>hi</b> there" },
    ]);
    expect(fitMarkdownToLimit("   ", html, 64)).toEqual([]);
    expect(() => fitMarkdownToLimit("x", html, 8)).toThrow("limit is invalid");
  });

  it("splits the Markdown further and renders again when the rendering overshoots", () => {
    const markdown = Array.from({ length: 12 }, (_, index) => `**${index}** & ${"w".repeat(6)}`).join(" ");
    const fitted = fitMarkdownToLimit(markdown, html, 64);
    expect(fitted.length).toBeGreaterThan(1);
    for (const message of fitted) {
      expect(codePointLength(message.rendered)).toBeLessThanOrEqual(64);
      expect(codePointLength(message.markdown)).toBeLessThanOrEqual(64);
      expect(message.rendered).toBe(html(message.markdown));
      expect(message.rendered).not.toMatch(/&am?$|<b$/);
    }
    expect(fitted.map((message) => message.markdown).join(" ")).toBe(markdown);
  });

  it("keeps Markdown that fits but renders long from being cut inside markup", () => {
    const markdown = Array.from({ length: 20 }, () => "**ab**").join(" ");
    const fitted = fitMarkdownToLimit(markdown, html, 40);
    expect(fitted.every((message) => codePointLength(message.rendered) <= 40)).toBe(true);
    expect(fitted.every((message) => /^(<b>ab<\/b>)( <b>ab<\/b>)*$/.test(message.rendered))).toBe(true);
  });
});
