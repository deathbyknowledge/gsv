import { describe, expect, it, vi } from "vitest";
import { RipgitKnowledgeStore } from "./knowledge-store";

describe("RipgitKnowledgeStore", () => {
  it("maps ripgit reads into knowledge file and directory results", async () => {
    const client = {
      readPath: vi.fn(async (_repo, path: string) => {
        if (path === "CONSTITUTION.md") {
          return {
            kind: "file" as const,
            bytes: new TextEncoder().encode("constitution"),
            size: 12,
          };
        }

        return {
          kind: "tree" as const,
          entries: [
            { name: "alpha.md", mode: "100644", hash: "1", type: "blob" as const },
            { name: "nested", mode: "040000", hash: "2", type: "tree" as const },
          ],
        };
      }),
      apply: vi.fn(),
      search: vi.fn(),
    };
    const store = new RipgitKnowledgeStore(client, { owner: "uid-1000", repo: "home" });

    const file = await store.read("CONSTITUTION.md");
    expect(file).toMatchObject({ kind: "file", size: 12 });

    const directory = await store.read("context.d");
    expect(directory).toEqual({
      kind: "directory",
      entries: [
        { name: "alpha.md", path: "context.d/alpha.md", kind: "file" },
        { name: "nested", path: "context.d/nested", kind: "directory" },
      ],
    });
  });

  it("writes and deletes repo-relative paths with author metadata", async () => {
    const client = {
      readPath: vi.fn(),
      apply: vi.fn(async () => {}),
      search: vi.fn(),
    };
    const store = new RipgitKnowledgeStore(client, { owner: "uid-1000", repo: "home" });

    await store.write("context.d/alpha.md", "alpha", {
      authorName: "sam",
      message: "gsv: write context.d/alpha.md",
    });
    await store.delete("context.d/empty", {
      authorName: "sam",
      message: "gsv: rm context.d/empty",
      recursive: true,
    });

    expect(client.apply).toHaveBeenNthCalledWith(
      1,
      { owner: "uid-1000", repo: "home" },
      "sam",
      "sam@gsv.internal",
      "gsv: write context.d/alpha.md",
      [
        {
          type: "put",
          path: "context.d/alpha.md",
          contentBytes: Array.from(new TextEncoder().encode("alpha")),
        },
      ],
    );

    expect(client.apply).toHaveBeenNthCalledWith(
      2,
      { owner: "uid-1000", repo: "home" },
      "sam",
      "sam@gsv.internal",
      "gsv: rm context.d/empty",
      [
        { type: "delete", path: "context.d/empty", recursive: true },
        { type: "delete", path: "context.d/empty/.dir" },
      ],
    );
  });

  it("filters search results by include glob and limit", async () => {
    const client = {
      readPath: vi.fn(),
      apply: vi.fn(),
      search: vi.fn(async () => ({
        matches: [
          { path: "context.d/alpha.md", line: 1, content: "needle" },
          { path: "context.d/image.png", line: 1, content: "needle" },
          { path: "CONSTITUTION.md", line: 2, content: "needle" },
        ],
      })),
    };
    const store = new RipgitKnowledgeStore(client, { owner: "uid-1000", repo: "home" });

    const result = await store.search("needle", {
      include: "*.md",
      limit: 1,
    });

    expect(result).toEqual({
      matches: [
        { path: "context.d/alpha.md", line: 1, content: "needle" },
      ],
      truncated: true,
    });
  });
});
