import { describe, expect, it } from "vitest";
import { parse as parseMarkdown } from "marked";
import { prepareMarkdownBlocks } from "./markdownParser";

function html(source: string): string {
  return prepareMarkdownBlocks(source).map((block) => block.html).join("");
}

describe("prepareMarkdownBlocks", () => {
  it("preserves nested inline, links, fences, and GFM tables", () => {
    const rendered = html([
      "Intro **bold _nested_** and [link](https://example.test).",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"));

    expect(rendered).toContain("<strong>bold <em>nested</em></strong>");
    expect(rendered).toContain('href="https://example.test"');
    expect(rendered).toContain("<pre><code class=\"language-ts\">");
    expect(rendered).toContain("<table>");
  });

  it("reinterprets earlier references from the authoritative full snapshot", () => {
    const source = "[later][id]\n\nTitle\n=====\n\n[id]: https://example.test";
    const rendered = html(source);
    expect(rendered).toContain('<a href="https://example.test">later</a>');
    expect(rendered).toContain("<h1>Title</h1>");
  });

  it("matches one-shot output at every Unicode scalar append boundary", () => {
    const source = "Hello **wørld 🌍**\n\n- one\n- two";
    let prefix = "";
    for (const scalar of source) {
      prefix += scalar;
      expect(html(prefix)).toBe(parseMarkdown(prefix, { breaks: true, gfm: true }));
    }
    expect(html(prefix)).toBe(html(source));
  });
});
