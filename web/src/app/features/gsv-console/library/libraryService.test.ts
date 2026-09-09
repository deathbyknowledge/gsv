import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { RepoReadResult } from "@humansandmachines/gsv/protocol";
import { saveLibraryPage } from "./libraryService";

function file(path: string, content: string | null, isBinary = false): RepoReadResult {
  return { repo: "agent/knowledge", ref: "HEAD", path, kind: "file", size: content?.length ?? 4, content, isBinary };
}

function saveClient(index: RepoReadResult | Error) {
  const client = { call: vi.fn<GSVClient["call"]>(), request: vi.fn<GSVClient["request"]>() };
  client.call.mockResolvedValueOnce({ repos: [
    { repo: "agent/knowledge", owner: "agent", name: "knowledge", kind: "user", writable: true, public: false },
  ] });
  client.call.mockResolvedValueOnce(file("wiki.json", JSON.stringify({ kind: "gsv.wiki", id: "personal", title: "Personal" })));
  if (index instanceof Error) client.call.mockRejectedValueOnce(index);
  else client.call.mockResolvedValueOnce(index);
  return client;
}

describe("library page saving", () => {
  it("saves an explicit overview edit without automatic index changes", async () => {
    const client = saveClient(file("index.md", "Unused"));
    const markdown = "# Updated overview\n\nAuthored text.\n";

    await saveLibraryPage(client, { db: "personal", path: "index.md", markdown });

    expect(client.call.mock.calls.map(([call]) => call)).toEqual(["repo.list", "repo.read", "repo.apply"]);
    expect(client.call).toHaveBeenLastCalledWith("repo.apply", {
      repo: "agent/knowledge",
      message: "wiki: update personal/index.md",
      ops: [{ type: "put", path: "index.md", content: markdown }],
    });
  });

  it("edits the selected repository page without rewriting its authored overview", async () => {
    const index = "---\nowner: person\n---\n# My memory\n\nAn authored introduction.\n\n## Pages\n\n- pages/example.md\n\n## Decisions\n\nKeep this paragraph and [link](https://example.test).\n\n### Detail\n\n| One | Two |\n| --- | --- |\n| a | b |\n";
    const client = saveClient(file("index.md", index));

    expect(await saveLibraryPage(client, {
      db: "personal", path: "personal/pages/example.md", markdown: "# Corrected\n\nUpdated page.\n",
    })).toEqual({ db: "personal", openPath: "personal/pages/example.md", statusText: "Saved personal/pages/example.md" });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", {
      repo: "agent/knowledge",
      message: "wiki: update personal/pages/example.md",
      ops: [{ type: "put", path: "pages/example.md", content: "# Corrected\n\nUpdated page.\n" }],
    });
  });

  it("adds a missing page entry while retaining every authored byte and CRLF", async () => {
    const before = "---\r\nowner: person\r\n---\r\n# Memory\r\n\r\n## Pages\r\n\r\n- pages/old.md\r\n\r\n";
    const after = "## Decisions\r\n\r\nKeep this.\r\n";
    const client = saveClient(file("index.md", before + after));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${before}- pages/new.md\r\n\r\n${after}` },
      ],
    }));
  });

  it("adds a Pages section to an authored overview that has none", async () => {
    const index = "# Memory\n\n## Decisions\n\nKeep this verbatim.";
    const client = saveClient(file("index.md", index));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${index}\n\n## Pages\n\n- pages/new.md\n` },
      ],
    }));
  });

  it("creates an absent index with its first page instead of retaining the empty placeholder", async () => {
    const client = saveClient(new Error("Path not found: index.md"));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: "# Personal\n\n## Pages\n\n- pages/new.md\n" },
      ],
    }));
  });

  it("replaces only the generated empty placeholder inside an authored overview", async () => {
    const before = "# Memory\r\n\r\nAn introduction.\r\n\r\n## Pages\r\n\r\n";
    const after = "\r\n\r\n## Decisions\r\n\r\nKeep this.\r\n";
    const client = saveClient(file("index.md", before + "- _No pages yet._" + after));

    await saveLibraryPage(client, { db: "personal", path: "pages/first.md", markdown: "First page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/first.md", content: "First page." },
        { type: "put", path: "index.md", content: before + "- pages/first.md" + after },
      ],
    }));
  });

  it.each(["```", "~~~~"])("preserves an authored %s code example containing Pages and the empty placeholder", async (fence) => {
    const example = `# Reference\n\nExample template:\n\n${fence}md\n## Pages\n\n- _No pages yet._\n${fence}\n`;
    const client = saveClient(file("index.md", example));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${example}\n## Pages\n\n- pages/new.md\n` },
      ],
    }));
  });

  it("ignores frontmatter and code placeholders while selecting the real Pages section", async () => {
    const prefix = "---\n## Pages\n- _No pages yet._\n---\n# Memory\n\n## Pages\n\n```md\n- _No pages yet._\n```\n\n";
    const suffix = "## Decisions\n\nKeep this.\n";
    const client = saveClient(file("index.md", prefix + suffix));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${prefix}- pages/new.md\n\n${suffix}` },
      ],
    }));
  });

  it("does not mistake an indented or fenced example for an existing page entry", async () => {
    const index = "# Memory\n\n    - pages/new.md\n\n```md\n- pages/new.md\n```\n";
    const client = saveClient(file("index.md", index));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${index}\n## Pages\n\n- pages/new.md\n` },
      ],
    }));
  });

  it.each([
    "<!-- Hidden example\r\n## Pages\r\n\r\n- _No pages yet._\r\n-->\r\n",
    "<pre>\r\n## Pages\r\n\r\n- _No pages yet._\r\n</pre>\r\n",
    "<script>\r\n## Pages\r\n\r\n- _No pages yet._\r\n</script>\r\n",
  ])("preserves raw HTML example bytes while appending a real index", async (example) => {
    const index = `# Reference\r\n\r\n${example}`;
    const client = saveClient(file("index.md", index));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: `${index}\r\n## Pages\r\n\r\n- pages/new.md\r\n` },
      ],
    }));
  });

  it("keeps original offsets after tab-indented code and mixed line endings", async () => {
    const prefix = "# Reference\r\n\r\n\t## Pages\r\n\t- _No pages yet._\r\n\r\n## Pages\n\n";
    const suffix = "\r\n\r\n## Decisions\r\n\r\nKeep this.\r\n";
    const client = saveClient(file("index.md", prefix + "- _No pages yet._" + suffix));

    await saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." });

    expect(client.call).toHaveBeenLastCalledWith("repo.apply", expect.objectContaining({
      ops: [
        { type: "put", path: "pages/new.md", content: "New page." },
        { type: "put", path: "index.md", content: prefix + "- pages/new.md" + suffix },
      ],
    }));
  });

  it.each([
    file("index.md", null, true),
    { repo: "agent/knowledge", ref: "HEAD", path: "index.md", kind: "tree", entries: [] } satisfies RepoReadResult,
  ])("does not overwrite a non-text overview while saving another page", async (index) => {
    const client = saveClient(index);

    await expect(saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." }))
      .rejects.toThrow("The collection overview is not a readable text file.");
    expect(client.call.mock.calls.some(([call]) => call === "repo.apply")).toBe(false);
  });

  it("does not treat a repository failure as a missing overview", async () => {
    const error = new Error("Repository not found: agent/knowledge");
    const client = saveClient(error);

    await expect(saveLibraryPage(client, { db: "personal", path: "pages/new.md", markdown: "New page." }))
      .rejects.toBe(error);
    expect(client.call.mock.calls.some(([call]) => call === "repo.apply")).toBe(false);
  });

  it.each(["shared/pages/example.md", "personal/pages/../../other.md"])(
    "rejects a wrong-collection or invalid page path before making requests: %s", async (path) => {
      const client = saveClient(file("index.md", ""));

      await expect(saveLibraryPage(client, { db: "personal", path, markdown: "Changed" })).rejects.toThrow();
      expect(client.call).not.toHaveBeenCalled();
    },
  );
});
