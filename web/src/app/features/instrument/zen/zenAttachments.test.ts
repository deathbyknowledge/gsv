import { describe, expect, it } from "vitest";
import { LONG_PASTE_CHARACTERS, LONG_PASTE_LINES, longPaste, zenAttachment, zenDraftMessage } from "./zenAttachments";

describe("Zen attachment drafts", () => {
  it("keeps the File as a body and identifies its media kind", () => {
    const file = new File(["image bytes"], "image.png", { type: "image/png" });
    expect(zenAttachment(file)).toMatchObject({ body: file, type: "image", mimeType: "image/png", filename: "image.png" });
    expect(zenAttachment(new File([], "notes.txt"))).toMatchObject({ type: "document", mimeType: "application/octet-stream" });
  });

});

describe("Zen long pastes", () => {
  it("leaves pastes at or under both thresholds to the prompt", () => {
    expect(longPaste("a".repeat(LONG_PASTE_CHARACTERS))).toBeNull();
    expect(longPaste(Array.from({ length: LONG_PASTE_LINES }, (_, index) => `line ${index}`).join("\n"))).toBeNull();
    expect(longPaste(" \n\t\n ")).toBeNull();
  });

  it("never folds whitespace alone, however long, since a chip of it would send nothing", () => {
    expect(longPaste(" ".repeat(LONG_PASTE_CHARACTERS + 1))).toBeNull();
    expect(longPaste("\n".repeat(LONG_PASTE_LINES + 1))).toBeNull();
  });

  it("folds a paste over the character threshold, counting characters as people see them", () => {
    expect(longPaste("a".repeat(LONG_PASTE_CHARACTERS + 1))).toMatchObject({ characters: LONG_PASTE_CHARACTERS + 1 });
    expect(longPaste("🚀".repeat(LONG_PASTE_CHARACTERS + 1))?.characters).toBe(LONG_PASTE_CHARACTERS + 1);
    expect(longPaste("🚀".repeat(LONG_PASTE_CHARACTERS / 2 + 1))).toBeNull();
  });

  it("folds a paste with more lines than the line threshold, however short", () => {
    const text = Array.from({ length: LONG_PASTE_LINES + 1 }, (_, index) => `${index}`).join("\n");
    expect(longPaste(text)).toMatchObject({ text, characters: text.length });
  });

  it("normalizes line endings and keeps everything else, including blank lines and trailing spaces", () => {
    const body = Array.from({ length: LONG_PASTE_LINES + 1 }, () => "  indented  ").join("\r\n");
    const raw = `\r\n\r\n${body}\r\n  \r\n`;
    expect(longPaste(raw)?.text).toBe(raw.replaceAll("\r\n", "\n"));
  });

  it("sends typed words first, then pasted blocks in paste order, separated by blank lines", () => {
    const first = { id: "first", text: "first block", characters: 11 };
    const second = { id: "second", text: "second\nblock", characters: 12 };
    expect(zenDraftMessage("What is wrong here?", [first, second])).toBe("What is wrong here?\n\nfirst block\n\nsecond\nblock");
    expect(zenDraftMessage("  ", [first])).toBe("first block");
    expect(zenDraftMessage("", [first, second])).toBe("first block\n\nsecond\nblock");
    expect(zenDraftMessage("Only words", [])).toBe("Only words");
  });
});
