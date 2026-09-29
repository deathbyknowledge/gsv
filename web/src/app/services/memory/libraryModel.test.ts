import { describe, expect, it } from "vitest";
import {
  ancestorFolderPaths,
  buildLibraryTree,
  extractLibraryTitle,
  normalizeDbScopedLibraryPath,
  normalizeLibraryPath,
  slugifyLibraryId,
  suggestLibraryPagePath,
} from "./libraryModel";

describe("libraryModel", () => {
  it("normalizes collection-scoped wiki paths", () => {
    expect(normalizeLibraryPath("/memory/pages/auth.md")).toBe("memory/pages/auth.md");
    expect(normalizeDbScopedLibraryPath("pages/auth.md", "memory")).toBe("memory/pages/auth.md");
    expect(normalizeDbScopedLibraryPath("memory/pages/auth.md", "memory")).toBe("memory/pages/auth.md");
  });

  it("rejects unsafe path segments", () => {
    expect(() => normalizeLibraryPath("memory/../secrets.md")).toThrow("invalid library path");
  });

  it("derives ids, titles, and suggested page paths", () => {
    expect(slugifyLibraryId("Agent Memory.md")).toBe("agent-memory");
    expect(extractLibraryTitle("# Agent Memory\n\nBody", "memory/index.md")).toBe("Agent Memory");
    expect(suggestLibraryPagePath("memory", "Auth Notes")).toBe("memory/pages/auth-notes.md");
  });

  it("builds a collapsed folder tree model from wiki pages", () => {
    const tree = buildLibraryTree([
      { kind: "file", path: "memory/index.md", title: "Memory" },
      { kind: "file", path: "memory/pages/team/auth.md", title: "Auth" },
      { kind: "file", path: "memory/pages/team/billing.md", title: "Billing" },
    ], "memory");

    expect(tree.children.map((node) => node.title)).toEqual(["Overview", "Pages"]);
    expect(tree.children[1].children[0].title).toBe("Team");
    expect(tree.children[1].children[0].count).toBe(2);
    expect(ancestorFolderPaths("pages/team/auth.md")).toEqual(["pages", "pages/team"]);
  });
});
