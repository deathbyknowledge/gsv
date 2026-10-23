import { describe, expect, it } from "vitest";
import { attachmentPreviewKind } from "./attachmentKind";

describe("attachment preview policy", () => {
  it.each([
    "main.go", "Main.java", "main.c", "main.h", "module.cpp", "module.hpp", "module.cc",
    "main.rs", "main.py", "main.rb", "index.php", "Main.cs", "Main.kt", "main.kts",
    "main.swift", "Main.scala", "run.sh", "run.bash", "run.zsh", "run.ps1", "query.sql",
    "config.yaml", "config.yml", "config.toml", "config.ini", "app.conf", "main.tf",
    "main.lua", "main.pl", "analysis.r", "main.dart", "main.ex", "main.exs", "main.erl",
    "main.hrl", "main.clj", "Main.hs", "App.vue", "App.svelte", "Dockerfile", "src/Dockerfile",
  ])("previews %s without a specific browser MIME type", (filename) => {
    for (const mime of ["", "application/octet-stream", "text/plain"]) {
      expect(attachmentPreviewKind(mime, filename)).toBe("text");
      expect(attachmentPreviewKind(mime, filename.toUpperCase())).toBe("text");
    }
  });

  it.each(["page.html", "page.htm", "page.xhtml", "image.svg"])("keeps active filename %s unsupported", (filename) => {
    for (const mime of ["", "application/octet-stream", "text/plain", "application/xml"]) {
      expect(attachmentPreviewKind(mime, filename)).toBe("unsupported");
    }
  });

  it.each(["text/html", "image/svg+xml", "application/xhtml+xml", "application/zip", "application/wasm"])("does not override explicit %s with a source filename", (mime) => {
    expect(attachmentPreviewKind(mime, "main.go")).toBe("unsupported");
    expect(attachmentPreviewKind(mime, "Dockerfile")).toBe("unsupported");
  });

  it.each(["app.exe", "image.png", "archive.zip", "blob.bin", "notdockerfile", "Dockerfile.exe"])("does not guess binary or unmatched filename %s", (filename) => {
    expect(attachmentPreviewKind("application/octet-stream", filename)).toBe("unsupported");
  });

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
