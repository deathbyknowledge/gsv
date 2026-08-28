import { describe, expect, it } from "vitest";
import {
  commitRepoSourceChanges,
  createProcessSourceBackend,
  getRepoSourceStatus,
} from "./index";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RepoSummary } from "@humansandmachines/gsv/protocol";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
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
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
      objects.set(key, { bytes, httpMetadata: options?.httpMetadata });
      return null;
    },
    async delete(key: string | string[]) {
      for (const entry of Array.isArray(key) ? key : [key]) {
        objects.delete(entry);
      }
    },
  };
  // SAFETY: this test bucket implements the R2 operations exercised by the source backend.
  return bucket as R2Bucket & { objects: typeof objects };
}

type LegacyManifestChange =
  | {
      type: "put";
      path: string;
      contentKey: string;
      size: number;
      updatedAt: number;
    }
  | {
      type: "delete";
      path: string;
      recursive: boolean;
      updatedAt: number;
    };

async function seedLegacyOverlay(
  storage: ReturnType<typeof makeBucket>,
  repo: string,
  changes: Array<
    | { type: "put"; path: string; content: string }
    | { type: "delete"; path: string; recursive?: boolean }
  >,
  processId = "task:source",
  baseRef = "main",
) {
  const sourceKey = `repo:${repo}`;
  const packageKey = `global:${sourceKey}`;
  const root = `process-source-overlays/${encodeURIComponent(processId)}/${encodeURIComponent(packageKey)}`;
  const manifestKey = `${root}/manifest.json`;
  const manifestChanges: Record<string, LegacyManifestChange> = {};
  const contentKeys: string[] = [];
  for (const change of changes) {
    if (change.type === "put") {
      const bytes = new TextEncoder().encode(change.content);
      const contentKey = `${root}/files/${encodeURIComponent(change.path)}`;
      await storage.put(contentKey, bytes);
      contentKeys.push(contentKey);
      manifestChanges[change.path] = {
        type: "put",
        path: change.path,
        contentKey,
        size: bytes.byteLength,
        updatedAt: 1,
      };
    } else {
      manifestChanges[change.path] = {
        type: "delete",
        path: change.path,
        recursive: change.recursive === true,
        updatedAt: 1,
      };
    }
  }
  await storage.put(manifestKey, JSON.stringify({
    version: 1,
    packageId: sourceKey,
    packageKey,
    baseRef,
    createdAt: 1,
    updatedAt: 1,
    changes: manifestChanges,
  }));
  return { manifestKey, contentKeys };
}

describe("createProcessSourceBackend", () => {
  it("lists visible ripgit repo owners and repos under /src/repos", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [
        makeRepo("sam/docs"),
        makeRepo("sam/tools"),
        makeRepo("root/gsv-manual", { public: true, writable: false }),
        makeRepo("bob/public", { public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async () => {
          throw new Error("readPath should not be called for virtual repo dirs");
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
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
  });

  it("reads and searches repo content through /src/repos/owner/repo", async () => {
    const calls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const searchCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; query: string; prefix?: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
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
          return { kind: "missing" };
        },
        search: async (repo: { owner: string; repo: string; branch?: string }, query: string, prefix?: string) => {
          searchCalls.push({ repo, query, prefix });
          return {
            truncated: false,
            matches: [{ path: "README.md", line: 2, content: "visible repo file" }],
          };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
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

    expect(calls).toEqual([
      {
        repo: { owner: "sam", repo: "docs", branch: "main" },
        path: "",
      },
      {
        repo: { owner: "sam", repo: "docs", branch: "main" },
        path: "README.md",
      },
    ]);
    expect(searchCalls).toEqual([{
      repo: { owner: "sam", repo: "docs", branch: "main" },
      query: "visible",
      prefix: undefined,
    }]);
  });

  it("commits owned repo writes directly through ripgit", async () => {
    const files = new Map<string, string>([
      ["notes.md", "old\n"],
      ["old.md", "remove me\n"],
    ]);
    const applyCalls: any[] = [];
    const config = makeConfig();
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (_repo: { owner: string; repo: string; branch?: string }, path: string) => {
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
          // SAFETY: Ripgit apply receives ops as its fifth argument by contract.
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
        refs: async () => ({
          heads: { main: applyCalls.length === 0 ? "mainhead123" : `repohead${applyCalls.length}` },
          tags: {},
        }),
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await backend!.writeFile("/src/repos/sam/docs/new.md", "created\n");
    await backend!.appendFile("/src/repos/sam/docs/notes.md", "more\n");
    await backend!.rm("/src/repos/sam/docs/old.md");

    await expect(storage.get(
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json",
    )).resolves.toBeNull();
    expect(storage.objects.size).toBe(0);
    expect(applyCalls).toHaveLength(3);
    await expect(backend!.readFile("/src/repos/sam/docs/new.md")).resolves.toBe("created\n");
    await expect(backend!.readFile("/src/repos/sam/docs/notes.md")).resolves.toBe("old\nmore\n");
    await expect(backend!.readFile("/src/repos/sam/docs/old.md")).rejects.toThrow("ENOENT");

    await expect(getRepoSourceStatus({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/docs")],
      processId: "other-process",
      config,
      ripgit: null,
    }, "sam/docs")).resolves.toMatchObject({
      changes: [],
    });

    const status = await getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      ripgit: null,
    }, "sam/docs");
    expect(status).toMatchObject({
      branch: "main",
      head: "repohead3",
      changes: [],
    });
    expect(files.get("new.md")).toBe("created\n");
    expect(files.get("notes.md")).toBe("old\nmore\n");
    expect(files.has("old.md")).toBe(false);
    expect(applyCalls[0][0]).toEqual({ owner: "sam", repo: "docs", branch: "main" });
    expect(applyCalls.map((call) => call[3])).toEqual([
      "gsv: write new.md",
      "gsv: append notes.md",
      "gsv: rm old.md",
    ]);
    expect(applyCalls[0][5]).toEqual({ baseRef: "mainhead123", expectedHead: "mainhead123" });
    expect(applyCalls[1][5]).toEqual({ baseRef: "repohead1", expectedHead: "repohead1" });
    expect(applyCalls[2][5]).toEqual({ baseRef: "repohead2", expectedHead: "repohead2" });
  });

  it("refreshes the active branch head before each automatic commit", async () => {
    let branchHead = "mainhead123";
    const applyCalls: any[] = [];
    const readRefs: string[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async (repo: { branch?: string }) => {
          readRefs.push(repo.branch ?? "");
          return { kind: "missing" };
        },
        refs: async () => ({ heads: { main: branchHead }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          branchHead = `writehead${applyCalls.length}`;
          return { head: branchHead };
        },
      } as any,
    });

    await backend!.writeFile("/src/repos/sam/docs/one.md", "one\n");
    branchHead = "externalhead456";
    await backend!.writeFile("/src/repos/sam/docs/two.md", "two\n");

    expect(readRefs).toEqual(["mainhead123", "externalhead456"]);
    expect(applyCalls[0][5]).toEqual({ baseRef: "mainhead123", expectedHead: "mainhead123" });
    expect(applyCalls[1][5]).toEqual({ baseRef: "externalhead456", expectedHead: "externalhead456" });
  });

  it("commits a legacy overlay before applying the next direct write", async () => {
    const files = new Map<string, string>();
    const applyCalls: any[] = [];
    const config = makeConfig();
    const storage = makeBucket();
    const overlay = await seedLegacyOverlay(storage, "sam/docs", [{
      type: "put",
      path: "legacy.md",
      content: "recover me\n",
    }]);
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
    const ripgit = {
      readPath: async (_repo: { branch?: string }, path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          return { kind: "missing" };
        }
        return {
          kind: "file",
          bytes: new TextEncoder().encode(content),
          size: content.length,
        };
      },
      refs: async () => ({
        heads: { main: applyCalls.length === 0 ? "mainhead123" : `repohead${applyCalls.length}` },
        tags: {},
      }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        // SAFETY: Ripgit apply receives ops as its fifth argument by contract.
        const ops = args[4] as Array<{ type: string; path: string; contentBytes?: number[] }>;
        for (const op of ops) {
          if (op.type === "put" && op.contentBytes) {
            files.set(op.path, new TextDecoder().decode(new Uint8Array(op.contentBytes)));
          }
        }
        return { head: `repohead${applyCalls.length}` };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/docs/new.md", "new\n");

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls.map((call) => call[3])).toEqual([
      "gsv: recover staged source changes",
      "gsv: write new.md",
    ]);
    expect(applyCalls[0][4]).toEqual([{
      type: "put",
      path: "legacy.md",
      contentBytes: Array.from(new TextEncoder().encode("recover me\n")),
    }]);
    expect(applyCalls[0][5]).toEqual({ baseRef: "mainhead123", expectedHead: "mainhead123" });
    expect(applyCalls[1][5]).toEqual({ baseRef: "repohead1", expectedHead: "repohead1" });
    expect(files.get("legacy.md")).toBe("recover me\n");
    expect(files.get("new.md")).toBe("new\n");
    await expect(storage.get(overlay.manifestKey)).resolves.toBeNull();
    await expect(storage.get(overlay.contentKeys[0])).resolves.toBeNull();
  });

  it("preserves a legacy overlay when its migration conflicts", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const overlay = await seedLegacyOverlay(storage, "sam/docs", [{
      type: "put",
      path: "legacy.md",
      content: "recover me\n",
    }]);
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
        refs: async () => ({ heads: { main: "moved-head" }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          throw new Error("ref moved during apply");
        },
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/sam/docs/new.md", "new\n"))
      .rejects.toThrow("ref moved during apply");

    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][3]).toBe("gsv: recover staged source changes");
    await expect(storage.get(overlay.manifestKey)).resolves.not.toBeNull();
    await expect(storage.get(overlay.contentKeys[0])).resolves.not.toBeNull();
    await expect(getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      ripgit: null,
    }, "sam/docs")).resolves.toMatchObject({
      changes: [{ type: "put", path: "legacy.md" }],
    });
  });

  it("refuses to discard a legacy overlay whose staged bytes are missing", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const overlay = await seedLegacyOverlay(storage, "sam/docs", [{
      type: "put",
      path: "legacy.md",
      content: "recover me\n",
    }]);
    await storage.delete(overlay.contentKeys[0]);
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          return { head: "unexpected" };
        },
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/sam/docs/new.md", "new\n"))
      .rejects.toThrow("Legacy staged content is unavailable: sam/docs/legacy.md");

    expect(applyCalls).toHaveLength(0);
    await expect(storage.get(overlay.manifestKey)).resolves.not.toBeNull();
  });

  it("preserves an invalid legacy overlay for explicit recovery", async () => {
    const storage = makeBucket();
    const overlay = await seedLegacyOverlay(storage, "sam/docs", [{
      type: "put",
      path: "legacy.md",
      content: "recover me\n",
    }]);
    await storage.put(overlay.manifestKey, "{");
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          return { head: "unexpected" };
        },
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/sam/docs/new.md", "new\n"))
      .rejects.toThrow("Invalid legacy source overlay for sam/docs");

    expect(applyCalls).toHaveLength(0);
    await expect(storage.get(overlay.manifestKey)).resolves.not.toBeNull();
    await expect(storage.get(overlay.contentKeys[0])).resolves.not.toBeNull();
  });

  it("keeps public non-owned repos read-only through /src/repos", async () => {
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv-manual", { public: true, writable: false })],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          return { head: "repohead123" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
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
      repos: [
        makeRepo("root/gsv-manual", { kind: "user", public: true, writable: false }),
        makeRepo("bob/public", { public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
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
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.readdir("/src/repos/root")).resolves.toEqual(["gsv-manual"]);
    await expect(backend!.readdir("/src/repos/bob")).resolves.toEqual(["public"]);
    await expect(backend!.readFile("/src/repos/root/gsv-manual/README.md")).resolves.toBe("manual\n");
    await expect(backend!.readFile("/src/repos/bob/private/README.md")).rejects.toThrow("no such source repo");
  });

  it("keeps listed repos visible under /src/repos", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [
        makeRepo("root/gsv", { kind: "user", public: false, writable: false }),
        makeRepo("root/gsv-manual", { kind: "user", public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          if (repo.owner === "root" && repo.repo === "gsv" && path === "README.md") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("gsv source\n"),
              size: 11,
            };
          }
          if (repo.owner === "root" && repo.repo === "gsv" && path === "packages/chat/package.json") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("{\"name\":\"chat\"}\n"),
              size: 16,
            };
          }
          return { kind: "missing" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.readdir("/src/repos/root")).resolves.toEqual(["gsv", "gsv-manual"]);
    await expect(backend!.readFile("/src/repos/root/gsv/README.md")).resolves.toBe("gsv source\n");
    await expect(backend!.readFile("/src/repos/root/gsv/packages/chat/package.json")).resolves.toContain("chat");
  });

  it("reads repos at their configured base ref", async () => {
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv", { kind: "user", writable: false, ref: "feature/review", baseRef: "commit123" })],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          readCalls.push({ repo, path });
          if (repo.branch === "commit123" && path === "packages/chat/package.json") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("{\"name\":\"chat\"}\n"),
              size: 16,
            };
          }
          return { kind: "missing" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.readFile("/src/repos/root/gsv/packages/chat/package.json")).resolves.toContain("chat");
    expect(readCalls).toEqual([{
      repo: { owner: "root", repo: "gsv", branch: "commit123" },
      path: "packages/chat/package.json",
    }]);
  });

  it("auto-commits repos to their configured source ref by default", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
    const ripgit = {
      readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        return { kind: "missing" };
      },
      refs: async () => ({ heads: {}, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "featurehead123" };
      },
    } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any;
    const repos = [makeRepo("sam/pkg-test", {
      kind: "user",
      writable: true,
      ref: "feature/review",
      baseRef: "commit123",
    })];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const review = true;\n");
    const result = await getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test");

    expect(result).toMatchObject({
      sourceRef: "feature/review",
      baseRef: "commit123",
      branch: "feature/review",
      head: "featurehead123",
    });
    expect(readCalls).toEqual([{
      repo: { owner: "sam", repo: "pkg-test", branch: "commit123" },
      path: "packages/sample-console/src/index.ts",
    }]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/review",
    });
    expect(applyCalls[0][3]).toBe("gsv: write packages/sample-console/src/index.ts");
    expect(applyCalls[0][5]).toEqual({ baseRef: "commit123" });
  });

  it("locks the first automatic commit to the configured branch head", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
    const ripgit = {
      readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        return { kind: "missing" };
      },
      refs: async () => ({ heads: { "feature/review": "movedhead456" }, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "featurehead123" };
      },
    } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any;
    const repos = [makeRepo("sam/pkg-test", {
      kind: "user",
      writable: true,
      ref: "feature/review",
      baseRef: "commit123",
    })];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const review = true;\n");

    expect(readCalls).toEqual([{
      repo: { owner: "sam", repo: "pkg-test", branch: "commit123" },
      path: "packages/sample-console/src/index.ts",
    }]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/review",
    });
    expect(applyCalls[0][5]).toEqual({ baseRef: "commit123", expectedHead: "commit123" });
  });

  it("reads nested subdirectories through the canonical repo path", async () => {
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/mono")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          readCalls.push({ repo, path });
          if (path === "packages/app/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const app = true;\n"),
              size: 25,
            };
          }
          if (path === "packages/other/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const other = true;\n"),
              size: 27,
            };
          }
          return { kind: "missing" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.readFile("/src/repos/sam/mono/packages/app/index.ts"))
      .resolves.toContain("app = true");
    await expect(backend!.readFile("/src/repos/sam/mono/packages/other/index.ts"))
      .resolves.toContain("other = true");
    expect(readCalls).toEqual([
      {
        repo: { owner: "sam", repo: "mono", branch: "main" },
        path: "packages/app/index.ts",
      },
      {
        repo: { owner: "sam", repo: "mono", branch: "main" },
        path: "packages/other/index.ts",
      },
    ]);
  });

  it("does not reuse expectedHead after selecting a different branch", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const heads = ["processhead123", "featurehead456", "featurehead789"];
    const branchHeads = new Map<string, string>();
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
    const ripgit = {
      readPath: async () => ({ kind: "missing" }),
      refs: async () => ({ heads: Object.fromEntries(branchHeads), tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        const head = heads[applyCalls.length - 1];
        branchHeads.set(args[0].branch, head);
        return { head };
      },
    } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/one.ts", "export const one = true;\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", {
      message: "repo: select feature",
      branch: "feature/package-work",
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/two.ts", "export const two = true;\n");

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[1][5]).toEqual({ baseRef: "processhead123" });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/three.ts", "export const three = true;\n");

    expect(applyCalls).toHaveLength(3);
    expect(applyCalls[2][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[2][5]).toEqual({ baseRef: "featurehead456", expectedHead: "featurehead456" });
  });

  it("compares automatic writes against the selected branch head", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { branch?: string }; path: string }> = [];
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
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
    } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    });

    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: select existing branch", branch: "feature/package-work" });
    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const changed = true;\n");

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

  it("reads from the active process branch head between automatic commits", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const filePath = "packages/sample-console/src/index.ts";
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
    const ripgit = {
      readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        if (path !== filePath) {
          return { kind: "missing" };
        }
        const text = repo.branch === "main" ? "main\n" : "branch\n";
        return {
          kind: "file",
          bytes: new TextEncoder().encode(text),
          size: text.length,
        };
      },
      refs: async () => ({
        heads: applyCalls.length === 0
          ? {}
          : { "feature/package-work": "processhead123" },
        tags: {},
      }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: applyCalls.length === 1 ? "processhead123" : "processhead456" };
      },
    } as any;
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    });

    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: select branch", branch: "feature/package-work" });
    await backend!.writeFile(`/src/repos/sam/pkg-test/${filePath}`, "branch\n");
    expect(readCalls).toEqual([{
      repo: { owner: "sam", repo: "pkg-test", branch: "main" },
      path: filePath,
    }]);

    readCalls.length = 0;
    await backend!.appendFile(`/src/repos/sam/pkg-test/${filePath}`, "next\n");

    expect(readCalls.length).toBeGreaterThan(0);
    expect(readCalls.map((call) => call.repo.branch)).toEqual([
      "feature/package-work",
      "feature/package-work",
      "processhead123",
    ]);
    expect(applyCalls[1][4]).toEqual([{
      type: "put",
      path: filePath,
      contentBytes: Array.from(new TextEncoder().encode("branch\nnext\n")),
    }]);
    expect(applyCalls[1][5]).toEqual({ baseRef: "processhead123", expectedHead: "processhead123" });
  });

  it("remembers an explicit target branch when an automatic write is a no-op", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    // SAFETY: typed ripgit fixture implements only methods exercised by this test.
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
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/one.ts", "export const one = true;\n");
    const result = await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: select feature", branch: "feature/package-work" });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const same = true;\n");

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
    await expect(getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test")).resolves.toMatchObject({
      branch: "feature/package-work",
      baseRef: "featurehead456",
      head: "featurehead456",
    });
  });

  it("commits recursive directory deletes immediately", async () => {
    let deleted = false;
    const applyCalls: any[] = [];
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (_repo: { owner: string; repo: string; branch?: string }, path: string) => {
          if (path === "packages/sample-console") {
            return {
              kind: "tree",
              entries: deleted
                ? []
                : [{ name: "src", mode: "040000", hash: "tree1", type: "tree" }],
            };
          }
          if (!deleted && path === "packages/sample-console/src") {
            return {
              kind: "tree",
              entries: [{ name: "index.ts", mode: "100644", hash: "blob1", type: "blob" }],
            };
          }
          return { kind: "missing" };
        },
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          deleted = true;
          return { head: "deletehead123" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).resolves.toEqual(["index.ts"]);
    await backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src", { recursive: true });

    await expect(backend!.stat("/src/repos/sam/pkg-test/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console")).resolves.toEqual([]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][4]).toEqual([{
      type: "delete",
      path: "packages/sample-console/src",
      recursive: true,
    }]);
    expect(storage.objects.size).toBe(0);
  });

  it("preserves parent directories when deleting nested source files", async () => {
    let hasIndex = true;
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async (_repo: { owner: string; repo: string; branch?: string }, path: string) => {
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
                ...(hasIndex
                  ? [{ name: "index.ts", mode: "100644", hash: "blob1", type: "blob" as const }]
                  : []),
                { name: "other.ts", mode: "100644", hash: "blob2", type: "blob" },
              ],
            };
          }
          if (hasIndex && path === "packages/sample-console/src/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const index = true;\n"),
              size: 27,
            };
          }
          return { kind: "missing" };
        },
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
        apply: async (...args: any[]) => {
          applyCalls.push(args);
          hasIndex = false;
          return { head: "deletehead123" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts");

    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console")).resolves.toEqual(["src"]);
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).resolves.toEqual(["other.ts"]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][4]).toEqual([{
      type: "delete",
      path: "packages/sample-console/src/index.ts",
      recursive: false,
    }]);
  });

  it("rejects source rm for missing paths unless forced", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: this fixture implements only the RipgitClient methods exercised here.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/missing.ts"))
      .rejects.toThrow("ENOENT");
    expect(storage.objects.size).toBe(0);

    await expect(backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/missing.ts", { force: true }))
      .resolves.toBeUndefined();
    expect(storage.objects.size).toBe(0);
  });

  it("rejects non-recursive source rm for non-empty directories", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async (_repo: { owner: string; repo: string; branch?: string }, path: string) => {
          if (path === "packages/sample-console/src") {
            return {
              kind: "tree",
              entries: [{ name: "index.ts", mode: "100644", hash: "blob1", type: "blob" }],
            };
          }
          return { kind: "missing" };
        },
      } /* SAFETY: typed ripgit fixture implements only exercised methods. */ as any,
    });

    await expect(backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src"))
      .rejects.toThrow("ENOTEMPTY");
    expect(storage.objects.size).toBe(0);
  });

  it("keeps repos from other owners read-only", async () => {
    // SAFETY: this fixture supplies only the readPath method exercised by the test.
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv", { kind: "user", writable: false })],
      processId: "task:source",
      config: makeConfig(),
      // SAFETY: typed ripgit fixture implements only methods exercised by this test.
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } /* SAFETY: typed ripgit fixture implements only methods exercised here. */ as any,
    });

    await expect(backend!.writeFile("/src/repos/root/gsv/packages/wiki/src/index.ts", "x")).rejects.toThrow("read-only");
  });
});
