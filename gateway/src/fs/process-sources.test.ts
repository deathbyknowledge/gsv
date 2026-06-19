import { describe, expect, it } from "vitest";
import { commitProcessSourceChanges, createProcessSourceBackend, getProcessSourceStatus } from "./index";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RepoSummary } from "@humansandmachines/gsv/protocol";
import type { InstalledPackageRecord } from "../kernel/packages";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:sam/pkg-test:packages/sample-console",
    scope: { kind: "user", uid: 1000 },
    manifest: {
      name: "sample-console",
      description: "Sample console",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "sam/pkg-test",
        ref: "main",
        subdir: "packages/sample-console",
        resolvedCommit: "base123",
      },
      entrypoints: [{ name: "Console", kind: "ui", module: "main.js", route: "/apps/sample-console" }],
    },
    artifact: { hash: "hash1", mainModule: "main.js", modulePaths: ["main.js"] },
    enabled: true,
    reviewRequired: false,
    reviewedAt: 1,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  } as InstalledPackageRecord;
}

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

function makeConfig() {
  const values = new Map<string, string>();
  return {
    get(key: string) {
      return values.get(key) ?? null;
    },
    set(key: string, value: string) {
      values.set(key, value);
    },
    values,
  };
}

function makeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }>();
  const bucket = {
    objects,
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) {
        return null;
      }
      return {
        key,
        size: stored.bytes.byteLength,
        uploaded: new Date(),
        httpMetadata: stored.httpMetadata,
        customMetadata: {},
        async text() {
          return new TextDecoder().decode(stored.bytes);
        },
        async arrayBuffer() {
          return stored.bytes.buffer.slice(
            stored.bytes.byteOffset,
            stored.bytes.byteOffset + stored.bytes.byteLength,
          );
        },
      };
    },
    async put(key: string, value: string | Uint8Array, options?: { httpMetadata?: R2HTTPMetadata }) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, { bytes, httpMetadata: options?.httpMetadata });
      return null;
    },
    async delete(key: string | string[]) {
      for (const entry of Array.isArray(key) ? key : [key]) {
        objects.delete(entry);
      }
    },
  };
  return bucket as unknown as R2Bucket & { objects: typeof objects };
}

describe("createProcessSourceBackend", () => {
  it("lists visible ripgit repo owners and repos under /src/repos", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [],
      repos: [
        makeRepo("sam/docs"),
        makeRepo("sam/tools"),
        makeRepo("root/gsv-manual", { public: true, writable: false }),
        makeRepo("bob/public", { public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => {
          throw new Error("readPath should not be called for virtual repo dirs");
        },
      } as any,
    });

    expect(backend).not.toBeNull();
    await expect(backend!.readdir("/src")).resolves.toEqual(["packages", "repos"]);
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
  });

  it("reads and searches non-package repo content through /src/repos/owner/repo", async () => {
    const calls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const searchCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; query: string; prefix?: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          calls.push({ repo, path });
          if (path === "") {
            return {
              kind: "tree",
              entries: [{ name: "README.md", mode: "100644", hash: "readme", type: "blob" }],
            };
          }
          if (repo.owner === "sam" && repo.repo === "docs" && path === "README.md") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("# Docs\nvisible repo file\n"),
              size: 25,
            };
          }
          if (path === "packages/sample-console/src/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const packageSourceStillWorks = true;\n"),
              size: 44,
            };
          }
          return { kind: "missing" };
        },
        search: async (repo: { owner: string; repo: string; branch?: string }, query: string, prefix?: string) => {
          searchCalls.push({ repo, query, prefix });
          return {
            truncated: false,
            matches: [{ path: "README.md", line: 2, content: "visible repo file" }],
          };
        },
      } as any,
    });

    await expect(backend!.readdir("/src/repos/sam/docs")).resolves.toEqual(["README.md"]);
    await expect(backend!.readFile("/src/repos/sam/docs/README.md")).resolves.toContain("visible repo file");
    await expect(backend!.readFile("/src/packages/sample-console/src/index.ts"))
      .resolves.toContain("packageSourceStillWorks");
    await expect(backend!.search("/src/repos/sam/docs", "visible")).resolves.toMatchObject({
      matches: [{
        path: "/src/repos/sam/docs/README.md",
        line: 2,
        content: "visible repo file",
      }],
    });

    expect(calls).toEqual([
      {
        repo: { owner: "sam", repo: "docs", branch: "main" },
        path: "",
      },
      {
        repo: { owner: "sam", repo: "docs", branch: "main" },
        path: "README.md",
      },
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/sample-console/src/index.ts",
      },
    ]);
    expect(searchCalls).toEqual([{
      repo: { owner: "sam", repo: "docs", branch: "main" },
      query: "visible",
      prefix: undefined,
    }]);
  });

  it("writes owned non-package repos directly through ripgit", async () => {
    const files = new Map<string, string>([
      ["notes.md", "old\n"],
      ["old.md", "remove me\n"],
    ]);
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (_repo: unknown, path: string) => {
          const content = files.get(path);
          if (content !== undefined) {
            return {
              kind: "file",
              bytes: new TextEncoder().encode(content),
              size: content.length,
            };
          }
          return { kind: "missing" };
        },
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          const ops = args[4] as Array<{ type: string; path: string; contentBytes?: number[] }>;
          for (const op of ops) {
            if (op.type === "put" && op.contentBytes) {
              files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
            } else if (op.type === "delete") {
              files.delete(op.path);
            }
          }
          return { head: `repohead${applyCalls.length}` };
        },
      } as any,
    });

    await backend!.writeFile("/src/repos/sam/docs/new.md", "created\n");
    await backend!.appendFile("/src/repos/sam/docs/notes.md", "more\n");
    await backend!.rm("/src/repos/sam/docs/old.md");

    expect(files.get("new.md")).toBe("created\n");
    expect(files.get("notes.md")).toBe("old\nmore\n");
    expect(files.has("old.md")).toBe(false);
    expect(applyCalls).toHaveLength(3);
    expect(applyCalls[0][0]).toEqual({ owner: "sam", repo: "docs", branch: "main" });
    expect(applyCalls[0][3]).toBe("gsv: write new.md");
    expect(applyCalls[0][4]).toEqual([{
      type: "put",
      path: "new.md",
      contentBytes: Array.from(new TextEncoder().encode("created\n")),
    }]);
    expect(applyCalls[1][3]).toBe("gsv: append notes.md");
    expect(applyCalls[1][4]).toEqual([{
      type: "put",
      path: "notes.md",
      contentBytes: Array.from(new TextEncoder().encode("old\nmore\n")),
    }]);
    expect(applyCalls[2][3]).toBe("gsv: rm old.md");
    expect(applyCalls[2][4]).toEqual([{
      type: "delete",
      path: "old.md",
      recursive: false,
    }]);
  });

  it("keeps public non-owned repos read-only through /src/repos", async () => {
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [],
      repos: [makeRepo("root/gsv-manual", { public: true, writable: false })],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          return { head: "repohead123" };
        },
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/root/gsv-manual/README.md", "x"))
      .rejects.toThrow("read-only");
    await expect(backend!.appendFile("/src/repos/root/gsv-manual/README.md", "x"))
      .rejects.toThrow("read-only");
    await expect(backend!.rm("/src/repos/root/gsv-manual/README.md", { force: true }))
      .rejects.toThrow("read-only");
    expect(applyCalls).toHaveLength(0);
  });

  it("exposes public manual repos supplied by repo visibility and hides absent private repos", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [],
      repos: [
        makeRepo("root/gsv-manual", { kind: "user", public: true, writable: false }),
        makeRepo("bob/public", { public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          if (repo.owner === "root" && repo.repo === "gsv-manual" && path === "README.md") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("manual\n"),
              size: 7,
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await expect(backend!.readdir("/src/repos/root")).resolves.toEqual(["gsv-manual"]);
    await expect(backend!.readdir("/src/repos/bob")).resolves.toEqual(["public"]);
    await expect(backend!.readFile("/src/repos/root/gsv-manual/README.md")).resolves.toBe("manual\n");
    await expect(backend!.readFile("/src/repos/bob/private/README.md")).rejects.toThrow("no such source repo");
  });

  it("preserves exact package source repo mounts when generic repo owners overlap", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      repos: [makeRepo("legacy/notes")],
      mounts: [{
        kind: "ripgit-source",
        packageId: "import:sam/pkg-test:packages/sample-console",
        mountPath: "/src/repos/legacy",
        repo: "sam/pkg-test",
        ref: "main",
        subdir: "packages/sample-console",
        resolvedCommit: "base123",
      }],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          if (repo.owner === "sam" && repo.repo === "pkg-test" && path === "packages/sample-console/package.json") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("{\"name\":\"sample-console\"}\n"),
              size: 26,
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await expect(backend!.readFile("/src/repos/legacy/package.json")).resolves.toContain("sample-console");
    await expect(backend!.readdir("/src/repos")).resolves.toEqual(["legacy"]);
  });

  it("mounts visible package source under /src/packages", async () => {
    const calls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo, path) => {
          calls.push({ repo, path });
          if (path === "packages/sample-console") {
            return {
              kind: "tree",
              entries: [{ name: "src", mode: "040000", hash: "tree1", type: "tree" }],
            };
          }
          return {
            kind: "file",
            bytes: new TextEncoder().encode("export const ok = true;\n"),
            size: 24,
          };
        },
      } as any,
    });

    expect(backend).not.toBeNull();
    await expect(backend!.readdir("/src")).resolves.toEqual(["packages"]);
    await expect(backend!.readdir("/src/packages")).resolves.toEqual(["sample-console"]);
    await expect(backend!.readdir("/src/packages/sample-console")).resolves.toEqual(["src"]);
    await expect(backend!.readFile("/src/packages/sample-console/src/index.ts")).resolves.toContain("ok = true");

    expect(calls).toEqual([
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/sample-console",
      },
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/sample-console/src/index.ts",
      },
    ]);
  });

  it("does not expose package sources for an explicit empty mount scope", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      mounts: [],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => {
          throw new Error("readPath should not be called");
        },
      } as any,
    });

    expect(backend).not.toBeNull();
    await expect(backend!.readdir("/src/packages")).resolves.toEqual([]);
    await expect(backend!.readFile("/src/packages/sample-console/src/index.ts"))
      .rejects.toThrow("no such package source");
  });

  it("stages package source edits and commits them explicitly", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: any[] = [];
    const ripgit = {
      readPath: async (repo: unknown, path: string) => {
        readCalls.push({ repo, path });
        return { kind: "missing" };
      },
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "processhead123" };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    });

    await expect(backend!.mkdir("/src/packages/sample-console")).resolves.toBeUndefined();
    await backend!.writeFile("/src/packages/sample-console/src/index.ts", "export const changed = true;\n");

    expect(applyCalls).toHaveLength(0);
    await expect(backend!.readFile("/src/packages/sample-console/src/index.ts")).resolves.toContain("changed = true");

    const result = await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: update source" });

    expect(result).toMatchObject({
      committed: true,
      baseRef: "base123",
      branch: "gsv/process/task-source/sample-console",
      commitHead: "processhead123",
      ops: 1,
      changes: [],
    });
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "gsv/process/task-source/sample-console",
    });
    expect(applyCalls[0][5]).toEqual({ baseRef: "base123" });
    expect(applyCalls[0][4]).toEqual([
      {
        type: "put",
        path: "packages/sample-console/src/index.ts",
        contentBytes: Array.from(new TextEncoder().encode("export const changed = true;\n")),
      },
    ]);

    const [state] = [...config.values.values()];
    expect(JSON.parse(state).branch).toBe("gsv/process/task-source/sample-console");
    await expect(getProcessSourceStatus({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage())).resolves.toMatchObject({
      baseRef: "base123",
      head: "processhead123",
    });
    expect(storage.objects.size).toBe(0);
  });

  it("commits staged source edits against the overlay base snapshot", async () => {
    const initialPackage = makePackage();
    const refreshedPackage = makePackage({
      manifest: {
        ...makePackage().manifest,
        source: {
          repo: "sam/pkg-test",
          ref: "main",
          subdir: "packages/sample-console",
          resolvedCommit: "newbase456",
        },
      },
    });
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { branch?: string }; path: string }> = [];
    const ripgit = {
      readPath: async (repo: { branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        return {
          kind: "file",
          bytes: new TextEncoder().encode("export const changed = false;\n"),
          size: 30,
        };
      },
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "processhead123" };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [initialPackage],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/packages/sample-console/src/index.ts", "export const changed = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [refreshedPackage],
      processId: "task:source",
      config,
      ripgit,
    }, refreshedPackage, { message: "pkg: commit staged base" });

    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/sample-console/src/index.ts",
      },
    ]);
    expect(applyCalls[0][5]).toEqual({ baseRef: "base123" });
  });

  it("keeps colliding package source path names visible with disambiguated names", async () => {
    const first = makePackage({
      packageId: "import:sam/demo-a:.",
      manifest: {
        ...makePackage().manifest,
        name: "Demo Tool",
        source: {
          repo: "sam/demo-a",
          ref: "main",
          subdir: ".",
          resolvedCommit: "first123",
        },
      },
    });
    const second = makePackage({
      packageId: "import:sam/demo-b:.",
      manifest: {
        ...makePackage().manifest,
        name: "demo-tool",
        source: {
          repo: "sam/demo-b",
          ref: "main",
          subdir: ".",
          resolvedCommit: "second123",
        },
      },
    });
    const readCalls: Array<{ repo: unknown; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [first, second],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: unknown, path: string) => {
          readCalls.push({ repo, path });
          return {
            kind: "file",
            bytes: new TextEncoder().encode(`from ${path}\n`),
            size: path.length + 6,
          };
        },
      } as any,
    });

    await expect(backend!.readdir("/src/packages")).resolves.toEqual([
      "demo-tool--sam-demo-a",
      "demo-tool--sam-demo-b",
    ]);
    await expect(backend!.readFile("/src/packages/demo-tool--sam-demo-a/src/index.ts"))
      .resolves.toContain("src/index.ts");
    await expect(backend!.readFile("/src/packages/demo-tool--sam-demo-b/src/index.ts"))
      .resolves.toContain("src/index.ts");

    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "demo-a", branch: "first123" },
        path: "src/index.ts",
      },
      {
        repo: { owner: "sam", repo: "demo-b", branch: "second123" },
        path: "src/index.ts",
      },
    ]);
  });

  it("uses disambiguated source path names for default process branches", async () => {
    const first = makePackage({
      packageId: "import:sam/mono:packages/one",
      manifest: {
        ...makePackage().manifest,
        name: "Demo Tool",
        source: {
          repo: "sam/mono",
          ref: "main",
          subdir: "packages/one",
          resolvedCommit: "onebase123",
        },
      },
    });
    const second = makePackage({
      packageId: "import:sam/mono:packages/two",
      manifest: {
        ...makePackage().manifest,
        name: "Demo Tool",
        source: {
          repo: "sam/mono",
          ref: "main",
          subdir: "packages/two",
          resolvedCommit: "twobase123",
        },
      },
    });
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const ripgit = {
      readPath: async () => ({ kind: "missing" }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: `head${applyCalls.length}` };
      },
    } as any;
    const packages = [first, second];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile(
      "/src/packages/demo-tool--sam-mono-packages-one/src/index.ts",
      "export const one = true;\n",
    );
    await backend!.writeFile(
      "/src/packages/demo-tool--sam-mono-packages-two/src/index.ts",
      "export const two = true;\n",
    );
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    }, first, { message: "pkg: commit one" });
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    }, second, { message: "pkg: commit two" });

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "mono",
      branch: "gsv/process/task-source/demo-tool--sam-mono-packages-one",
    });
    expect(applyCalls[1][0]).toEqual({
      owner: "sam",
      repo: "mono",
      branch: "gsv/process/task-source/demo-tool--sam-mono-packages-two",
    });
    expect(applyCalls[0][4][0].path).toBe("packages/one/src/index.ts");
    expect(applyCalls[1][4][0].path).toBe("packages/two/src/index.ts");
  });

  it("keeps process source state scoped by installed package record", async () => {
    const packageId = "import:sam/pkg-test:packages/sample-console";
    const globalPackage = makePackage({
      packageId,
      scope: { kind: "global" },
      manifest: {
        ...makePackage().manifest,
        source: {
          repo: "sam/pkg-test",
          ref: "main",
          subdir: "packages/sample-console",
          resolvedCommit: "globalbase123",
        },
      },
    });
    const userPackage = makePackage({
      packageId,
      scope: { kind: "user", uid: 1000 },
      manifest: {
        ...makePackage().manifest,
        source: {
          repo: "sam/pkg-test",
          ref: "main",
          subdir: "packages/sample-console",
          resolvedCommit: "userbase123",
        },
      },
    });
    const packages = [userPackage, globalPackage];
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const ripgit = {
      readPath: async () => ({ kind: "missing" }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: `head${applyCalls.length}` };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile(
      "/src/packages/sample-console--sam-pkg-test-packages-sample-console/src/index.ts",
      "export const scope = 'global';\n",
    );
    await backend!.writeFile(
      "/src/packages/sample-console--sam-pkg-test-packages-sample-console-2/src/index.ts",
      "export const scope = 'user';\n",
    );
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    }, globalPackage, { message: "pkg: commit global" });
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages,
      processId: "task:source",
      config,
      ripgit,
    }, userPackage, { message: "pkg: commit user" });

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0][5]).toEqual({ baseRef: "globalbase123" });
    expect(applyCalls[0][4][0].contentBytes).toEqual(
      Array.from(new TextEncoder().encode("export const scope = 'global';\n")),
    );
    expect(applyCalls[1][5]).toEqual({ baseRef: "userbase123" });
    expect(applyCalls[1][4][0].contentBytes).toEqual(
      Array.from(new TextEncoder().encode("export const scope = 'user';\n")),
    );
    expect([...config.values.keys()].sort()).toEqual([
      "process-source-branches/task%3Asource/global%3Aimport%3Asam%2Fpkg-test%3Apackages%2Fsample-console",
      "process-source-branches/task%3Asource/user%3A1000%3Aimport%3Asam%2Fpkg-test%3Apackages%2Fsample-console",
    ]);
    expect(storage.objects.size).toBe(0);
  });

  it("scopes source mounts and honors repo-root package mounts", async () => {
    const app = makePackage({
      packageId: "import:sam/mono:packages/app",
      manifest: {
        ...makePackage().manifest,
        name: "Demo App",
        source: {
          repo: "sam/mono",
          ref: "main",
          subdir: "packages/app",
          resolvedCommit: "base123",
        },
      },
    });
    const other = makePackage({
      packageId: "import:sam/mono:packages/other",
      manifest: {
        ...makePackage().manifest,
        name: "Other Tool",
        source: {
          repo: "sam/mono",
          ref: "main",
          subdir: "packages/other",
          resolvedCommit: "otherbase123",
        },
      },
    });
    const readCalls: Array<{ repo: unknown; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [app, other],
      mounts: [{
        kind: "ripgit-source",
        mountPath: "/src/repos/sam-mono",
        packageId: app.packageId,
        repo: "sam/mono",
        ref: "main",
        resolvedCommit: "base123",
        subdir: ".",
      }],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: unknown, path: string) => {
          readCalls.push({ repo, path });
          return {
            kind: "file",
            bytes: new TextEncoder().encode(`from ${path}\n`),
            size: path.length + 6,
          };
        },
      } as any,
    });

    await expect(backend!.readdir("/src")).resolves.toEqual(["packages", "repos"]);
    await expect(backend!.readdir("/src/repos")).resolves.toEqual(["sam-mono"]);
    await expect(backend!.readFile("/src/repos/sam-mono/package.json")).resolves.toContain("package.json");
    await expect(backend!.readFile("/src/packages/other-tool/package.json")).rejects.toThrow("no such package source");

    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "mono", branch: "base123" },
        path: "package.json",
      },
    ]);
  });

  it("resolves overlapping source mounts by longest mount path", async () => {
    const parent = makePackage({
      packageId: "import:sam/parent:.",
      manifest: {
        ...makePackage().manifest,
        name: "Parent",
        source: {
          repo: "sam/parent",
          ref: "main",
          subdir: ".",
          resolvedCommit: "parent123",
        },
      },
    });
    const child = makePackage({
      packageId: "import:sam/child:.",
      manifest: {
        ...makePackage().manifest,
        name: "Child",
        source: {
          repo: "sam/child",
          ref: "main",
          subdir: ".",
          resolvedCommit: "child123",
        },
      },
    });
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [parent, child],
      mounts: [
        {
          kind: "ripgit-source",
          mountPath: "/src/repos/foo",
          packageId: parent.packageId,
          repo: "sam/parent",
          ref: "main",
          resolvedCommit: "parent123",
          subdir: ".",
        },
        {
          kind: "ripgit-source",
          mountPath: "/src/repos/foo/bar",
          packageId: child.packageId,
          repo: "sam/child",
          ref: "main",
          resolvedCommit: "child123",
          subdir: ".",
        },
      ],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          readCalls.push({ repo, path });
          return {
            kind: "file",
            bytes: new TextEncoder().encode(`${repo.owner}/${repo.repo}:${path}\n`),
            size: path.length,
          };
        },
      } as any,
    });

    await expect(backend!.readFile("/src/repos/foo/bar/index.ts"))
      .resolves.toBe("sam/child:index.ts\n");
    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "child", branch: "child123" },
        path: "index.ts",
      },
    ]);
  });

  it("does not reuse expectedHead when committing to a different branch", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const heads = ["processhead123", "featurehead456", "featurehead789"];
    const ripgit = {
      readPath: async () => ({ kind: "missing" }),
      refs: async () => ({ heads: {}, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: heads[applyCalls.length - 1] };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/packages/sample-console/src/one.ts", "export const one = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: commit one" });

    await backend!.writeFile("/src/packages/sample-console/src/two.ts", "export const two = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: commit two", branch: "feature/package-work" });

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[1][5]).toEqual({ baseRef: "processhead123" });

    await backend!.writeFile("/src/packages/sample-console/src/three.ts", "export const three = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: commit three" });

    expect(applyCalls).toHaveLength(3);
    expect(applyCalls[2][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[2][5]).toEqual({ baseRef: "featurehead456", expectedHead: "featurehead456" });
  });

  it("compares staged source changes against an existing target branch", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { branch?: string }; path: string }> = [];
    const ripgit = {
      readPath: async (repo: { branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        if (repo.branch === "base123") {
          return {
            kind: "file",
            bytes: new TextEncoder().encode("export const changed = true;\n"),
            size: 29,
          };
        }
        return {
          kind: "file",
          bytes: new TextEncoder().encode("export const changed = false;\n"),
          size: 30,
        };
      },
      refs: async () => ({ heads: { "feature/package-work": "featurehead456" }, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "featurehead789" };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/packages/sample-console/src/index.ts", "export const changed = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: commit to existing branch", branch: "feature/package-work" });

    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "featurehead456" },
        path: "packages/sample-console/src/index.ts",
      },
    ]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[0][4]).toEqual([
      {
        type: "put",
        path: "packages/sample-console/src/index.ts",
        contentBytes: Array.from(new TextEncoder().encode("export const changed = true;\n")),
      },
    ]);
    expect(applyCalls[0][5]).toEqual({ baseRef: "featurehead456", expectedHead: "featurehead456" });
  });

  it("remembers an explicit target branch even when staged source edits are no-ops", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const ripgit = {
      readPath: async (repo: { branch?: string }) => {
        if (repo.branch === "featurehead456") {
          return {
            kind: "file",
            bytes: new TextEncoder().encode("export const same = true;\n"),
            size: 26,
          };
        }
        return { kind: "missing" };
      },
      refs: async () => ({ heads: { "feature/package-work": "featurehead456" }, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "processhead123" };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/packages/sample-console/src/one.ts", "export const one = true;\n");
    await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: commit one" });

    await backend!.writeFile("/src/packages/sample-console/src/index.ts", "export const same = true;\n");
    const result = await commitProcessSourceChanges({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage(), { message: "pkg: select feature", branch: "feature/package-work" });

    expect(result).toMatchObject({
      committed: false,
      branch: "feature/package-work",
      baseRef: "featurehead456",
      head: "featurehead456",
      commitHead: "featurehead456",
      ops: 0,
      changes: [],
    });
    expect(applyCalls).toHaveLength(1);
    await expect(getProcessSourceStatus({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config,
      ripgit,
    }, makePackage())).resolves.toMatchObject({
      branch: "feature/package-work",
      baseRef: "featurehead456",
      head: "featurehead456",
    });
  });

  it("treats recursively deleted overlay directories as missing in readdir", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (_repo: unknown, path: string) => {
          if (path === "packages/sample-console") {
            return {
              kind: "tree",
              entries: [{ name: "src", mode: "040000", hash: "tree1", type: "tree" }],
            };
          }
          if (path === "packages/sample-console/src") {
            return {
              kind: "tree",
              entries: [{ name: "index.ts", mode: "100644", hash: "blob1", type: "blob" }],
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await expect(backend!.readdir("/src/packages/sample-console/src")).resolves.toEqual(["index.ts"]);
    await backend!.rm("/src/packages/sample-console/src", { recursive: true });

    await expect(backend!.stat("/src/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/packages/sample-console")).resolves.toEqual([]);
  });

  it("preserves parent directories when deleting nested source files", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage()],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (_repo: unknown, path: string) => {
          if (path === "packages/sample-console") {
            return {
              kind: "tree",
              entries: [{ name: "src", mode: "040000", hash: "tree1", type: "tree" }],
            };
          }
          if (path === "packages/sample-console/src") {
            return {
              kind: "tree",
              entries: [
                { name: "index.ts", mode: "100644", hash: "blob1", type: "blob" },
                { name: "other.ts", mode: "100644", hash: "blob2", type: "blob" },
              ],
            };
          }
          if (path === "packages/sample-console/src/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const index = true;\n"),
              size: 27,
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await backend!.rm("/src/packages/sample-console/src/index.ts");

    await expect(backend!.readdir("/src/packages/sample-console")).resolves.toEqual(["src"]);
    await expect(backend!.readdir("/src/packages/sample-console/src")).resolves.toEqual(["other.ts"]);
  });

  it("rejects source rm for missing paths unless forced", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.rm("/src/packages/sample-console/missing.ts"))
      .rejects.toThrow("ENOENT");
    expect(storage.objects.size).toBe(0);

    await expect(backend!.rm("/src/packages/sample-console/missing.ts", { force: true }))
      .resolves.toBeUndefined();
    expect(storage.objects.size).toBe(0);
  });

  it("rejects non-recursive source rm for non-empty directories", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      packages: [makePackage()],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (_repo: unknown, path: string) => {
          if (path === "packages/sample-console/src") {
            return {
              kind: "tree",
              entries: [{ name: "index.ts", mode: "100644", hash: "blob1", type: "blob" }],
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await expect(backend!.rm("/src/packages/sample-console/src"))
      .rejects.toThrow("ENOTEMPTY");
    expect(storage.objects.size).toBe(0);
  });

  it("keeps package sources from other owners read-only", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      packages: [makePackage({
        packageId: "import:root/gsv:builtin-packages/wiki",
        scope: { kind: "global" },
        manifest: {
          ...makePackage().manifest,
          name: "wiki",
          source: {
            repo: "root/gsv",
            ref: "main",
            subdir: "builtin-packages/wiki",
            resolvedCommit: "rootbase",
          },
        },
      })],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.writeFile("/src/packages/wiki/src/index.ts", "x")).rejects.toThrow("read-only");
  });
});
