import { describe, expect, it } from "vitest";
import { attachmentPreviewKind } from "./attachmentPreview";

describe("attachment preview policy", () => {
  it.each([
    ["text/plain; charset=utf-8", "notes.txt", "text"],
    ["text/plain", "README.MD", "markdown"],
    ["text/markdown", "notes", "markdown"],
    ["application/octet-stream", "notes.md", "markdown"],
    ["application/json", "result", "text"],
    ["application/ld+json", "result", "text"],
    ["application/octet-stream", "result.json", "text"],
    ["text/csv", "table.csv", "text"],
    ["application/xml", "result.xml", "text"],
    ["", "code.py", "text"],
    ["APPLICATION/PDF", "report.pdf", "pdf"],
    ["image/png", "photo.png", "image"],
    ["text/html", "disguised.pdf", "unsupported"],
    ["image/svg+xml", "disguised.md", "unsupported"],
    ["application/xhtml+xml", "page", "unsupported"],
    ["application/octet-stream", "report.pdf", "unsupported"],
    ["application/zip", "archive.zip", "unsupported"],
  ])("classifies %s %s as %s", (mime, filename, kind) => {
    expect(attachmentPreviewKind(mime, filename)).toBe(kind);
  });
});
