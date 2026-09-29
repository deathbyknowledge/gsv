import { describe, expect, it } from "vitest";
import { resolveLibraryLink } from "./libraryLinks";

describe("library page links", () => {
  const resolve = (href: string) => resolveLibraryLink(href, "personal", "personal/pages/topics/coffee.md");

  it.each([
    ["tea.md", "personal/pages/topics/tea.md"],
    ["./tea.md#brewing", "personal/pages/topics/tea.md"],
    ["../zebra.md?view=read#details", "personal/pages/zebra.md"],
    ["../../index.md", "personal/index.md"],
    ["index.md", "personal/index.md"],
    ["pages/topics/tea.md", "personal/pages/topics/tea.md"],
    ["/pages/topics/tea.md", "personal/pages/topics/tea.md"],
    ["personal/pages/tea.md", "personal/pages/tea.md"],
    ["/work/pages/project.md", "work/pages/project.md"],
    ["work/index.md", "work/index.md"],
    ["tea%20notes.md", "personal/pages/topics/tea notes.md"],
    ["pages/tea%20notes.md", "personal/pages/tea notes.md"],
  ])("resolves %s within the wiki", (href, path) => {
    expect(resolve(href)).toBe(path);
  });

  it("resolves relative links beside a page whose directory needs URL escaping", () => {
    expect(resolveLibraryLink("tea.md", "personal", "personal/pages/food #1/coffee.md"))
      .toBe("personal/pages/food #1/tea.md");
  });

  it.each([
    "https://example.com/page", "//example.com/page", "mailto:person@example.com", "tel:1234",
    "gsv:/tmp/source.txt", "#details", "javascript:alert(1)", "../../../outside.md", "/outside.md",
    "pages/%2e%2e/outside.md", "%broken.md", "pages/foo%00.md", "..\\outside.md",
  ])("does not turn %s into a wiki path", (href) => {
    expect(resolve(href)).toBeNull();
  });
});
