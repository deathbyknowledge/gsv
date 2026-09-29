import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { RepoReadResult, RepoTreeEntry } from "@humansandmachines/gsv/protocol";
import { listLibraryCollections } from "../../../services/memory/libraryService";
import type { LibraryCollection } from "../../../services/memory/libraryTypes";
import { listMemoryPages, readMemoryPage, searchMemory } from "./memoryService";

const collection: LibraryCollection = {
  id: "personal",
  title: "Personal memory",
  repo: "agent/knowledge",
  writable: true,
  updatedAt: null,
};

function memoryClient() {
  return { call: vi.fn<GSVClient["call"]>(), request: vi.fn<GSVClient["request"]>() };
}

function tree(path: string, entries: Array<[string, RepoTreeEntry["type"]]>): RepoReadResult {
  return {
    repo: collection.repo,
    ref: "HEAD",
    path,
    kind: "tree",
    entries: entries.map(([name, type]) => ({
      name,
      path: path ? `${path}/${name}` : name,
      type,
      mode: type === "tree" ? "040000" : "100644",
      hash: `hash:${name}`,
    })),
  };
}

function file(path: string, content: string | null, isBinary = false): RepoReadResult {
  return {
    repo: collection.repo,
    ref: "HEAD",
    path,
    kind: "file",
    content,
    isBinary,
    size: content?.length ?? 4,
  };
}

describe("Memory repository browsing", () => {
  it("discovers collections from manifests and retains the repository and permission", async () => {
    const client = memoryClient();
    client.call.mockResolvedValueOnce({ repos: [
      { repo: "agent/knowledge", owner: "agent", name: "knowledge", kind: "user", writable: false, public: true },
      { repo: "agent/code", owner: "agent", name: "code", kind: "user", writable: true, public: false },
    ] });
    client.call.mockResolvedValueOnce(file("wiki.json", JSON.stringify({ kind: "gsv.wiki", id: "personal", title: "Personal memory" })));
    client.call.mockRejectedValueOnce(new Error("Path not found: wiki.json"));

    expect(await listLibraryCollections(client)).toEqual([{ ...collection, writable: false }]);
    expect(client.call.mock.calls).toEqual([
      ["repo.list", {}],
      ["repo.read", { repo: "agent/knowledge", path: "wiki.json" }],
      ["repo.read", { repo: "agent/code", path: "wiki.json" }],
    ]);
  });

  it("lists the overview and nested markdown pages without reading page contents", async () => {
    const client = memoryClient();
    client.call.mockResolvedValueOnce(tree("", [["wiki.json", "blob"], ["pages", "tree"], ["index.md", "blob"]]));
    client.call.mockResolvedValueOnce(tree("pages", [["zebra.md", "blob"], ["nested", "tree"], [".dir", "blob"], ["alpha_note.MD", "blob"], ["image.png", "blob"]]));
    client.call.mockResolvedValueOnce(tree("pages/nested", [["second-page.md", "blob"]]));

    expect(await listMemoryPages(client, collection)).toEqual([
      { kind: "file", path: "personal/index.md", title: "Overview" },
      { kind: "file", path: "personal/pages/alpha_note.MD", title: "Alpha Note" },
      { kind: "file", path: "personal/pages/nested/second-page.md", title: "Second Page" },
      { kind: "file", path: "personal/pages/zebra.md", title: "Zebra" },
    ]);
    expect(client.call.mock.calls).toEqual([
      ["repo.read", { repo: collection.repo, path: "" }],
      ["repo.read", { repo: collection.repo, path: "pages" }],
      ["repo.read", { repo: collection.repo, path: "pages/nested" }],
    ]);
  });

  it("keeps the overview when a collection has no pages directory", async () => {
    const client = memoryClient();
    client.call.mockResolvedValueOnce(tree("", [["index.md", "blob"]]));
    client.call.mockRejectedValueOnce(new Error("Path not found: pages"));

    expect(await listMemoryPages(client, collection)).toEqual([
      { kind: "file", path: "personal/index.md", title: "Overview" },
    ]);
  });

  it.each([
    "Forbidden: cannot read repo agent/knowledge",
    "Repository not found: agent/knowledge",
    "Gateway route not found",
    "Request timed out",
  ])("does not conceal repository or transport errors: %s", async (message) => {
    const client = memoryClient();
    const error = new Error(message);
    client.call.mockRejectedValue(error);

    await expect(listMemoryPages(client, collection)).rejects.toBe(error);
    await expect(readMemoryPage(client, collection, "personal/pages/example.md")).rejects.toBe(error);
  });
});

describe("Memory page reads", () => {
  it("opens exactly one page in its collection repository and retains its complete markdown", async () => {
    const client = memoryClient();
    const markdown = "---\ntitle: Frontmatter\n---\n# Authored title\n\nOriginal body.\n";
    client.call.mockResolvedValue(file("pages/nested/example.md", markdown));

    expect(await readMemoryPage(client, collection, "personal/pages/nested/example.md")).toEqual({
      path: "personal/pages/nested/example.md",
      title: "Authored title",
      markdown,
    });
    expect(client.call.mock.calls).toEqual([
      ["repo.read", { repo: collection.repo, path: "pages/nested/example.md" }],
    ]);
  });

  it("preserves a genuinely empty text page", async () => {
    const client = memoryClient();
    client.call.mockResolvedValue(file("pages/empty-page.md", ""));

    expect(await readMemoryPage(client, collection, "personal/pages/empty-page.md")).toEqual({
      path: "personal/pages/empty-page.md",
      title: "Empty Page",
      markdown: "",
    });
  });

  it.each([true, false])("rejects unreadable content instead of offering an empty replacement (binary=%s)", async (isBinary) => {
    const client = memoryClient();
    client.call.mockResolvedValue(file("pages/binary.md", null, isBinary));

    await expect(readMemoryPage(client, collection, "personal/pages/binary.md"))
      .rejects.toThrow("This page is not readable text.");
  });

  it("returns no page for a removed path or a directory", async () => {
    const client = memoryClient();
    client.call.mockRejectedValueOnce(new Error("Path not found: pages/deleted.md"));
    client.call.mockResolvedValueOnce(tree("pages", []));

    expect(await readMemoryPage(client, collection, "personal/pages/deleted.md")).toBeNull();
    expect(await readMemoryPage(client, collection, "personal/pages")).toBeNull();
  });

  it("rejects path traversal before issuing a repository read", async () => {
    const client = memoryClient();

    await expect(readMemoryPage(client, collection, "personal/pages/../../other.md"))
      .rejects.toThrow("invalid library path");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects a page from another collection before issuing a repository read", async () => {
    const client = memoryClient();

    await expect(readMemoryPage(client, collection, "shared/pages/example.md"))
      .rejects.toThrow("This page does not belong to the selected collection.");
    expect(client.call).not.toHaveBeenCalled();
  });
});

describe("Memory repository search", () => {
  it("groups and ranks gateway matches without reading pages and preserves partial-result status", async () => {
    const client = memoryClient();
    const firstLine = `  ${"x".repeat(170)}  `;
    client.call.mockResolvedValue({
      repo: collection.repo,
      ref: "HEAD",
      query: "lit:memory",
      truncated: true,
      matches: [
        { path: "pages/zebra.md", line: 2, content: "zebra memory" },
        { path: "index.md", line: 3, content: " overview memory " },
        { path: "pages/alpha.MD", line: 4, content: firstLine },
        { path: "pages/alpha.MD", line: 7, content: "second match" },
        { path: "wiki.json", line: 1, content: "not a page" },
      ],
    });

    expect(await searchMemory(client, collection, "lit:memory")).toEqual({
      entries: [
        { kind: "file", path: "personal/pages/alpha.MD", title: "Alpha", snippet: "x".repeat(160) },
        { kind: "file", path: "personal/index.md", title: "Overview", snippet: "overview memory" },
        { kind: "file", path: "personal/pages/zebra.md", title: "Zebra", snippet: "zebra memory" },
      ],
      truncated: true,
    });
    expect(client.call.mock.calls).toEqual([
      ["repo.search", { repo: collection.repo, query: "lit:memory" }],
    ]);
  });

  it("reports a complete empty search and propagates gateway failures", async () => {
    const client = memoryClient();
    const error = new Error("Search unavailable");
    client.call.mockResolvedValueOnce({ repo: collection.repo, ref: "HEAD", query: "missing", matches: [] });
    client.call.mockRejectedValueOnce(error);

    expect(await searchMemory(client, collection, "missing")).toEqual({ entries: [], truncated: false });
    await expect(searchMemory(client, collection, "memory")).rejects.toBe(error);
  });
});
