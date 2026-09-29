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
});
