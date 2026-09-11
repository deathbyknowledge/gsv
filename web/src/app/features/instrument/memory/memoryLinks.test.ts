import { describe, expect, it } from "vitest";
import { memoryLinkFromUrl, memoryLinkHref, resolveMemoryLink } from "./memoryLinks";

describe("Memory navigation", () => {
  const page = { db: "personal", path: "personal/pages/topics/coffee.md" };

  it("keeps local anchors on the current page", () => {
    expect(resolveMemoryLink("#brewing", page)).toEqual({ ...page, fragment: "brewing" });
  });

  it("retains the destination collection and heading", () => {
    expect(resolveMemoryLink("work/pages/project.md#next-steps", page)).toEqual({
      db: "work", path: "work/pages/project.md", fragment: "next-steps",
    });
  });

  it("round trips copied links with escaped paths and fragments", () => {
    const link = { db: "work", path: "work/pages/research & ideas.md", fragment: "café" };
    const url = new URL(memoryLinkHref(link), "https://gsv.example");
    expect(url.pathname).toBe("/memory");
    expect(memoryLinkFromUrl(url)).toEqual(link);
  });

  it("does not select a mismatched collection or an invalid path from a URL", () => {
    expect(memoryLinkFromUrl(new URL("https://gsv.example/memory"))).toBeNull();
    expect(memoryLinkFromUrl(new URL("https://gsv.example/memory?db=personal&path=work/pages/a.md"))).toBeNull();
    expect(memoryLinkFromUrl(new URL("https://gsv.example/memory?db=personal&path=personal/../a.md"))).toBeNull();
    expect(resolveMemoryLink("tea.md#%broken", page)).toBeNull();
  });
});
