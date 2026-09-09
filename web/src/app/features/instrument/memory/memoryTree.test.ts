import { describe, expect, it } from "vitest";
import type { LibraryEntry } from "../../gsv-console/library/libraryTypes";
import { buildMemoryTree, memoryTreePages } from "./memoryTree";

describe("Memory folder hierarchy", () => {
  const pages: LibraryEntry[] = [
    { kind: "file", path: "personal/pages/zebra.md", title: "Zebra" },
    { kind: "file", path: "personal/pages/topics/coffee.md", title: "Coffee" },
    { kind: "file", path: "personal/index.md", title: "Personal" },
    { kind: "file", path: "personal/pages/topics/beans/roast.md", title: "Roast" },
  ];

  it("keeps Overview first and exposes directories inside the collection's pages root", () => {
    const tree = buildMemoryTree(pages, "personal");
    expect(tree.map((node) => node.title)).toEqual(["Overview", "Topics", "Zebra"]);
    expect(tree[1].children.map((node) => node.title)).toEqual(["Beans", "Coffee"]);
    expect(tree[1].children[0].children[0].entry?.path).toBe("personal/pages/topics/beans/roast.md");
  });

  it("walks pages in the same order as the hierarchical sidebar", () => {
    expect(memoryTreePages(buildMemoryTree(pages, "personal")).map((entry) => entry.title))
      .toEqual(["Personal", "Roast", "Coffee", "Zebra"]);
  });

  it("supports empty collections and collections without an overview", () => {
    expect(buildMemoryTree([], "personal")).toEqual([]);
    expect(buildMemoryTree(pages.filter((entry) => !entry.path.endsWith("/index.md")), "personal")[0].title).toBe("Topics");
  });
});
