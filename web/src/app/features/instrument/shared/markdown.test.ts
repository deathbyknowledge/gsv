import { describe, expect, it } from "vitest";
import { escapeHtml, renderPlainTextHtml } from "./markdown";

describe("plain text projection", () => {
  it("keeps a person's line breaks and never reads their text as markup", () => {
    const typed = "cancel printer\nremind me of the plan for gmail\npark 3\nlets connect linear\ncontinue 5\ncontinue 6";
    expect(renderPlainTextHtml(typed)).toBe(typed);
    expect(renderPlainTextHtml("a < b\n**plain stars**")).toBe("a &lt; b\n**plain stars**");
    expect(renderPlainTextHtml("<img src=x onerror=alert(1)>")).toBe(escapeHtml("<img src=x onerror=alert(1)>"));
  });

  it("keeps one blank line between paragraphs and folds longer gaps", () => {
    expect(renderPlainTextHtml("first\n\nsecond")).toBe("first\n\nsecond");
    expect(renderPlainTextHtml("first\n\n\n\n\nsecond")).toBe("first\n\nsecond");
    expect(renderPlainTextHtml("first\n \n\t\n\nsecond")).toBe("first\n\nsecond");
    expect(renderPlainTextHtml("  indented\n    more")).toBe("  indented\n    more");
  });

  it("links web URLs in human messages and opens them in a new tab", () => {
    expect(renderPlainTextHtml("See https://example.com/a?x=1&y=2 and WWW.example.org."))
      .toBe('See <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://example.com/a?x=1&amp;y=2</a> and <a href="https://WWW.example.org" target="_blank" rel="noopener noreferrer">WWW.example.org</a>.');
  });

  it("keeps surrounding punctuation and markup inert", () => {
    expect(renderPlainTextHtml('(<b>https://example.com/a_(b)</b>), [https://example.org/x].'))
      .toBe('(&lt;b&gt;<a href="https://example.com/a_(b)" target="_blank" rel="noopener noreferrer">https://example.com/a_(b)</a>&lt;/b&gt;), [<a href="https://example.org/x" target="_blank" rel="noopener noreferrer">https://example.org/x</a>].');
    expect(renderPlainTextHtml('https://example.com/?q="<img src=x>" javascript:alert(1) https://'))
      .toBe('<a href="https://example.com/?q=" target="_blank" rel="noopener noreferrer">https://example.com/?q=</a>&quot;&lt;img src=x&gt;&quot; javascript:alert(1) https://');
  });
});
