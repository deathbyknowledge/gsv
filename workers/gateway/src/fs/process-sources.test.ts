import { describe, expect, it } from "vitest";
import {
  createProcessSourceBackend,
  type RipgitApplyOp,
  type RipgitClient,
  type RipgitRepoRef,
} from "./index";
import type {
  ProcessIdentity,
  RepoSummary,
} from "@humansandmachines/gsv/protocol";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

type ApplyCall = {
  repo: RipgitRepoRef;
  author: string;
  email: string;
  message: string;
  ops: RipgitApplyOp[];
};

function makeRepo(repo: string, partial?: Partial<RepoSummary>): RepoSummary {
  const [owner = "", name = ""] = repo.split("/");
  return {
    repo,
    owner,
    name,
    kind: "user",
    writable: owner === IDENTITY.username,
    public: false,
    ...partial,
  };
}

function makeRipgitFixture(
  initial: Record<string, string> = {},
  options?: { conflict?: boolean },
) {
  const files = new Map(Object.entries(initial));
  const readCalls: Array<{ repo: RipgitRepoRef; path: string }> = [];
  const searchCalls: Array<{
    repo: RipgitRepoRef;
    query: string;
    prefix?: string;
  }> = [];
  const applyCalls: ApplyCall[] = [];
  const client = {
    async readPath(repo: RipgitRepoRef, path: string) {
      readCalls.push({ repo, path });
      const content = files.get(path);
      if (content !== undefined) {
        return {
          kind: "file" as const,
          bytes: new TextEncoder().encode(content),
          size: content.length,
        };
      }

      const prefix = path ? `${path}/` : "";
      const entries = new Map<string, "blob" | "tree">();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }
        const remainder = filePath.slice(prefix.length);
        const [name = "", nested] = remainder.split("/", 2);
        if (name) {
          entries.set(name, nested ? "tree" : "blob");
        }
      }
      if (entries.size === 0) {
        return { kind: "missing" as const };
      }
      return {
        kind: "tree" as const,
        entries: [...entries].map(([name, type]) => ({
          name,
          mode: type === "tree" ? "040000" : "100644",
          hash: `${type}:${name}`,
          type,
        })),
      };
    },
    async search(
      repo: RipgitRepoRef,
      query: string,
      prefix?: string,
    ) {
      searchCalls.push({ repo, query, prefix });
      const matches = [];
      for (const [path, content] of files) {
        if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) {
          continue;
        }
        for (const [index, line] of content.split("\n").entries()) {
          if (line.includes(query)) {
            matches.push({ path, line: index + 1, content: line });
          }
        }
      }
      return { matches, truncated: false };
    },
    async apply(
      repo: RipgitRepoRef,
      author: string,
      email: string,
      message: string,
      ops: RipgitApplyOp[],
    ) {
      applyCalls.push({ repo, author, email, message, ops });
      if (options?.conflict) {
        return { head: "moved-head", conflict: true };
      }
      for (const op of ops) {
        if (op.type === "put") {
          files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
        } else if (op.type === "delete") {
          for (const path of files.keys()) {
            if (path === op.path || (op.recursive && path.startsWith(`${op.path}/`))) {
              files.delete(path);
            }
          }
        }
      }
      return { head: `head-${applyCalls.length}`, conflict: false };
    },
  };
  // SAFETY: this fixture implements every RipgitClient method exercised by these tests.
  return {
    client: client as RipgitClient,
    files,
    readCalls,
    searchCalls,
    applyCalls,
  };
}

describe("createProcessSourceBackend", () => {
  it("lists visible ripgit repo owners and repos under /src/repos", async () => {
    const ripgit = makeRipgitFixture();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [
        makeRepo("sam/docs"),
        makeRepo("sam/tools"),
        makeRepo("root/gsv-manual", { public: true, writable: false }),
        makeRepo("bob/public", { public: true, writable: false }),
      ],
      ripgit: ripgit.client,
    });

    expect(backend).not.toBeNull();
    await expect(backend!.readdir("/src")).resolves.toEqual(["repos"]);
    await expect(backend!.readdir("/src/repos")).resolves.toEqual(["bob", "root", "sam"]);
    await expect(backend!.readdir("/src/repos/sam")).resolves.toEqual(["docs", "tools"]);
    await expect(backend!.stat("/src/repos/sam/docs")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o755,
    });
    await expect(backend!.stat("/src/repos/root/gsv-manual")).resolves.toMatchObject({
      isDirectory: true,
      mode: 0o555,
    });
    expect(ripgit.readCalls).toHaveLength(0);
  });

  it("reads and searches repo content through the configured ref", async () => {
    const ripgit = makeRipgitFixture({
      "README.md": "# Docs\nvisible repo file\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/docs", { ref: "feature/docs", baseRef: "ignored-base" })],
      ripgit: ripgit.client,
    });

    await expect(backend!.readdir("/src/repos/sam/docs")).resolves.toEqual(["README.md"]);
    await expect(backend!.readFile("/src/repos/sam/docs/README.md")).resolves.toContain("visible repo file");
    await expect(backend!.search("/src/repos/sam/docs", "visible")).resolves.toMatchObject({
      matches: [{
        path: "/src/repos/sam/docs/README.md",
        line: 2,
        content: "visible repo file",
      }],
    });
    expect(ripgit.readCalls.every((call) => call.repo.branch === "feature/docs")).toBe(true);
    expect(ripgit.searchCalls).toEqual([{
      repo: { owner: "sam", repo: "docs", branch: "feature/docs" },
      query: "visible",
      prefix: undefined,
    }]);
  });

  it("commits writes, appends, and deletes directly to ripgit", async () => {
    const ripgit = makeRipgitFixture({
      "notes.md": "old\n",
      "old.md": "remove me\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/docs")],
      ripgit: ripgit.client,
    });

    await backend!.writeFile("/src/repos/sam/docs/new.md", "created\n");
    await backend!.appendFile("/src/repos/sam/docs/notes.md", "more\n");
    await backend!.rm("/src/repos/sam/docs/old.md");

    expect(ripgit.applyCalls).toHaveLength(3);
    expect(ripgit.applyCalls.map((call) => call.message)).toEqual([
      "gsv: write new.md",
      "gsv: append notes.md",
      "gsv: rm old.md",
    ]);
    expect(ripgit.applyCalls.every((call) => call.repo.branch === "main")).toBe(true);
    expect(ripgit.applyCalls[0].ops).toEqual([{
      type: "put",
      path: "new.md",
      contentBytes: Array.from(new TextEncoder().encode("created\n")),
    }]);
    expect(ripgit.files.get("new.md")).toBe("created\n");
    expect(ripgit.files.get("notes.md")).toBe("old\nmore\n");
    expect(ripgit.files.has("old.md")).toBe(false);
  });

  it("surfaces a ripgit conflict without a second storage path", async () => {
    const ripgit = makeRipgitFixture({}, { conflict: true });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/docs")],
      ripgit: ripgit.client,
    });

    await expect(backend!.writeFile("/src/repos/sam/docs/new.md", "new\n"))
      .rejects.toThrow("Repo ref moved while committing sam/docs");
    expect(ripgit.applyCalls).toHaveLength(1);
    expect(ripgit.files.has("new.md")).toBe(false);
  });

  it("keeps public non-owned repos read-only", async () => {
    const ripgit = makeRipgitFixture({ "README.md": "manual\n" });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("root/gsv-manual", { public: true, writable: false })],
      ripgit: ripgit.client,
    });

    await expect(backend!.readFile("/src/repos/root/gsv-manual/README.md"))
      .resolves.toBe("manual\n");
    await expect(backend!.writeFile("/src/repos/root/gsv-manual/README.md", "x"))
      .rejects.toThrow("read-only");
    await expect(backend!.appendFile("/src/repos/root/gsv-manual/README.md", "x"))
      .rejects.toThrow("read-only");
    await expect(backend!.rm("/src/repos/root/gsv-manual/README.md", { force: true }))
      .rejects.toThrow("read-only");
    expect(ripgit.applyCalls).toHaveLength(0);
  });

  it("hides repos absent from the visibility list", async () => {
    const ripgit = makeRipgitFixture({ "README.md": "visible\n" });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("bob/public", { public: true, writable: false })],
      ripgit: ripgit.client,
    });

    await expect(backend!.readFile("/src/repos/bob/public/README.md"))
      .resolves.toBe("visible\n");
    await expect(backend!.readFile("/src/repos/bob/private/README.md"))
      .rejects.toThrow("no such source repo");
  });

  it("reads nested subdirectories through the canonical repo path", async () => {
    const ripgit = makeRipgitFixture({
      "packages/app/index.ts": "export const app = true;\n",
      "packages/other/index.ts": "export const other = true;\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/mono")],
      ripgit: ripgit.client,
    });

    await expect(backend!.readFile("/src/repos/sam/mono/packages/app/index.ts"))
      .resolves.toContain("app = true");
    await expect(backend!.readFile("/src/repos/sam/mono/packages/other/index.ts"))
      .resolves.toContain("other = true");
  });

  it("commits recursive directory deletes immediately", async () => {
    const ripgit = makeRipgitFixture({
      "packages/sample/src/index.ts": "index\n",
      "packages/sample/src/nested/other.ts": "other\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/pkg-test")],
      ripgit: ripgit.client,
    });

    await backend!.rm("/src/repos/sam/pkg-test/packages/sample/src", { recursive: true });

    await expect(backend!.stat("/src/repos/sam/pkg-test/packages/sample/src"))
      .rejects.toThrow("ENOENT");
    expect(ripgit.applyCalls[0].ops).toEqual([{
      type: "delete",
      path: "packages/sample/src",
      recursive: true,
    }]);
  });

  it("preserves parent directories when deleting a nested file", async () => {
    const ripgit = makeRipgitFixture({
      "packages/sample/src/index.ts": "index\n",
      "packages/sample/src/other.ts": "other\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/pkg-test")],
      ripgit: ripgit.client,
    });

    await backend!.rm("/src/repos/sam/pkg-test/packages/sample/src/index.ts");

    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample"))
      .resolves.toEqual(["src"]);
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample/src"))
      .resolves.toEqual(["other.ts"]);
  });

  it("rejects rm for missing paths unless forced", async () => {
    const ripgit = makeRipgitFixture();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/pkg-test")],
      ripgit: ripgit.client,
    });

    await expect(backend!.rm("/src/repos/sam/pkg-test/missing.ts"))
      .rejects.toThrow("ENOENT");
    await expect(backend!.rm("/src/repos/sam/pkg-test/missing.ts", { force: true }))
      .resolves.toBeUndefined();
    expect(ripgit.applyCalls).toHaveLength(0);
  });

  it("rejects non-recursive rm for non-empty directories", async () => {
    const ripgit = makeRipgitFixture({
      "packages/sample/src/index.ts": "index\n",
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      repos: [makeRepo("sam/pkg-test")],
      ripgit: ripgit.client,
    });

    await expect(backend!.rm("/src/repos/sam/pkg-test/packages/sample/src"))
      .rejects.toThrow("ENOTEMPTY");
    expect(ripgit.applyCalls).toHaveLength(0);
  });
});
