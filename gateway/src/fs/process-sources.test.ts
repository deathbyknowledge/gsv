import { describe, expect, it, vi } from "vitest";
import {
  commitRepoSourceChanges,
  createProcessSourceBackend,
  discardRepoSourceChanges,
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

type BucketPutOptions = {
  onlyIf?: R2Conditional;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
};

type BucketHooks = {
  beforePut?: (
    key: string,
    value: string | Uint8Array,
    options?: BucketPutOptions,
  ) => void | Promise<void>;
  afterPut?: (
    key: string,
    value: string | Uint8Array,
    options?: BucketPutOptions,
  ) => void | Promise<void>;
  beforeDelete?: (key: string) => void | Promise<void>;
};

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bucketValueText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function makeBucket(hooks: BucketHooks = {}) {
  const objects = new Map<string, {
    bytes: Uint8Array;
    httpMetadata?: R2HTTPMetadata;
    customMetadata?: Record<string, string>;
    etag: string;
  }>();
  let nextEtag = 1;
  let conditionalFailures = 0;
  const bucket = {
    objects,
    get conditionalFailures() {
      return conditionalFailures;
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) {
        return null;
      }
      return {
        key,
        size: stored.bytes.byteLength,
        uploaded: new Date(),
        etag: stored.etag,
        httpEtag: `"${stored.etag}"`,
        httpMetadata: stored.httpMetadata,
        customMetadata: stored.customMetadata ?? {},
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
    async put(
      key: string,
      value: string | Uint8Array,
      options?: BucketPutOptions,
    ) {
      await hooks.beforePut?.(key, value, options);
      const existing = objects.get(key);
      if (
        options?.onlyIf?.etagMatches !== undefined &&
        existing?.etag !== options.onlyIf.etagMatches
      ) {
        conditionalFailures += 1;
        return null;
      }
      if (
        options?.onlyIf?.etagDoesNotMatch !== undefined &&
        (options.onlyIf.etagDoesNotMatch === "*"
          ? existing !== undefined
          : existing?.etag === options.onlyIf.etagDoesNotMatch)
      ) {
        conditionalFailures += 1;
        return null;
      }
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const etag = `etag-${nextEtag++}`;
      const stored = {
        bytes,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
        etag,
      };
      objects.set(key, stored);
      const result = {
        key,
        size: bytes.byteLength,
        uploaded: new Date(),
        etag,
        httpEtag: `"${etag}"`,
        httpMetadata: stored.httpMetadata,
        customMetadata: stored.customMetadata ?? {},
      };
      await hooks.afterPut?.(key, value, options);
      return result;
    },
    async delete(key: string | string[]) {
      for (const entry of Array.isArray(key) ? key : [key]) {
        await hooks.beforeDelete?.(entry);
        objects.delete(entry);
      }
    },
  };
  return bucket as unknown as R2Bucket & {
    objects: typeof objects;
    readonly conditionalFailures: number;
  };
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
      ripgit: {
        readPath: async () => {
          throw new Error("readPath should not be called for virtual repo dirs");
        },
      } as any,
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

  it("reads and searches non-package repo content through /src/repos/owner/repo", async () => {
    const calls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const searchCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; query: string; prefix?: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
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

  it("stages owned non-package repo writes before committing through ripgit", async () => {
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
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
      } as any,
    });

    await backend!.writeFile("/src/repos/sam/docs/new.md", "created\n");
    await backend!.appendFile("/src/repos/sam/docs/notes.md", "more\n");
    await backend!.rm("/src/repos/sam/docs/old.md");

    const manifest = await storage.get(
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json",
    );
    const storedManifest = JSON.parse(await manifest!.text()) as {
      changes: Record<string, { contentKey?: string; revision?: string }>;
    };
    expect(storedManifest).toMatchObject({
      packageId: "repo:sam/docs",
      packageKey: "global:repo:sam/docs",
    });
    const newChange = storedManifest.changes["new.md"];
    expect(newChange.revision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(newChange.contentKey).toBe(
      `process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/files/new.md/${newChange.revision}`,
    );
    expect(manifest!.customMetadata).toEqual({
      uid: "1000",
      gid: "1000",
      mode: "600",
    });
    const stagedContent = await storage.get(
      newChange.contentKey!,
    );
    expect(stagedContent!.customMetadata).toEqual({
      uid: "1000",
      gid: "1000",
      mode: "600",
    });

    expect(applyCalls).toHaveLength(0);
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
    expect(status.changes.map((change) => `${change.type}:${change.path}`)).toEqual([
      "put:new.md",
      "put:notes.md",
      "delete:old.md",
    ]);

    const result = await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config,
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
        refs: async () => ({ heads: { main: "mainhead123" }, tags: {} }),
      } as any,
    }, "sam/docs", { message: "update docs" });

    expect(result).toMatchObject({
      committed: true,
      branch: "main",
      commitHead: "repohead1",
      ops: 3,
      changes: [],
    });
    expect(files.get("new.md")).toBe("created\n");
    expect(files.get("notes.md")).toBe("old\nmore\n");
    expect(files.has("old.md")).toBe(false);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({ owner: "sam", repo: "docs", branch: "main" });
    expect(applyCalls[0][3]).toBe("update docs");
    expect(applyCalls[0][5]).toEqual({ baseRef: "mainhead123", expectedHead: "mainhead123" });
  });

  it("never follows a corrupted overlay manifest content key", async () => {
    const storage = makeBucket();
    const manifestKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json";
    const victimKey = "private/bob/closest-device/secrets.txt";
    await storage.put(victimKey, "bob's private data\n", {
      customMetadata: { uid: "2000", gid: "2000", mode: "600" },
    });
    await storage.put(manifestKey, JSON.stringify({
      version: 1,
      packageId: "repo:sam/docs",
      packageKey: "global:repo:sam/docs",
      baseRef: "main",
      createdAt: 1,
      updatedAt: 1,
      changes: {
        "leak.md": {
          type: "put",
          path: "leak.md",
          contentKey: victimKey,
          size: 19,
          updatedAt: 1,
        },
      },
    }));

    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.readFile("/src/repos/sam/docs/leak.md"))
      .rejects.toThrow("ENOENT");
    await discardRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: null,
    }, "sam/docs");

    await expect(storage.get(manifestKey).then(async (object) =>
      object ? JSON.parse(await object.text()).changes : null
    )).resolves.toEqual({});
    await expect(storage.get(victimKey).then((object) => object?.text()))
      .resolves.toBe("bob's private data\n");
  });

  it("reads and upgrades legacy deterministic overlay payload keys", async () => {
    const storage = makeBucket();
    const manifestKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json";
    const legacyContentKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/files/legacy.md";
    await storage.put(legacyContentKey, "legacy\n");
    await storage.put(manifestKey, JSON.stringify({
      version: 1,
      packageId: "repo:sam/docs",
      packageKey: "global:repo:sam/docs",
      baseRef: "main",
      createdAt: 1,
      updatedAt: 1,
      changes: {
        "legacy.md": {
          type: "put",
          path: "legacy.md",
          contentKey: legacyContentKey,
          size: 7,
          updatedAt: 1,
        },
      },
    }));
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.readFile("/src/repos/sam/docs/legacy.md")).resolves.toBe("legacy\n");
    await backend!.writeFile("/src/repos/sam/docs/legacy.md", "revisioned\n");

    await expect(storage.get(legacyContentKey)).resolves.toBeNull();
    await expect(backend!.readFile("/src/repos/sam/docs/legacy.md")).resolves.toBe("revisioned\n");
    const manifest = JSON.parse(await (await storage.get(manifestKey))!.text());
    expect(manifest.changes["legacy.md"]).toMatchObject({
      revision: expect.any(String),
    });
    expect(manifest.changes["legacy.md"].contentKey).not.toBe(legacyContentKey);
  });

  it("retries concurrent manifest updates without losing staged paths", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await Promise.all([
      backend!.writeFile("/src/repos/sam/docs/one.md", "one\n"),
      backend!.writeFile("/src/repos/sam/docs/two.md", "two\n"),
    ]);

    const status = await getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: null,
    }, "sam/docs");
    expect(status.changes.map((change) => change.path)).toEqual(["one.md", "two.md"]);
    expect(storage.conditionalFailures).toBeGreaterThan(0);
    await expect(backend!.readFile("/src/repos/sam/docs/one.md")).resolves.toBe("one\n");
    await expect(backend!.readFile("/src/repos/sam/docs/two.md")).resolves.toBe("two\n");
  });

  it("removes an immutable payload when manifest publication exhausts CAS retries", async () => {
    const manifestKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json";
    let invalidatingManifest = false;
    let storage!: ReturnType<typeof makeBucket>;
    storage = makeBucket({
      beforePut: async (key) => {
        if (key !== manifestKey || invalidatingManifest) {
          return;
        }
        invalidatingManifest = true;
        await storage.put(manifestKey, "{}\n");
        invalidatingManifest = false;
      },
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/sam/docs/failed.md", "never published\n"))
      .rejects.toThrow("EAGAIN");
    expect([...storage.objects.keys()].filter((key) => key.includes("/files/failed.md/")))
      .toEqual([]);
  });

  it("keeps the winning same-path manifest paired with its immutable payload", async () => {
    const firstManifestWaiting = makeDeferred();
    const secondManifestStored = makeDeferred();
    let delayedFirstManifest = false;
    const manifestKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json";
    const storage = makeBucket({
      beforePut: async (key, value) => {
        if (key !== manifestKey) {
          return;
        }
        const manifest = JSON.parse(bucketValueText(value));
        if (manifest.changes["same.md"]?.size === 2 && !delayedFirstManifest) {
          delayedFirstManifest = true;
          firstManifestWaiting.resolve();
          await secondManifestStored.promise;
        } else if (manifest.changes["same.md"]?.size === 5) {
          await firstManifestWaiting.promise;
        }
      },
      afterPut: (key, value) => {
        if (key !== manifestKey) {
          return;
        }
        const manifest = JSON.parse(bucketValueText(value));
        if (manifest.changes["same.md"]?.size === 5) {
          secondManifestStored.resolve();
        }
      },
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await Promise.all([
      backend!.writeFile("/src/repos/sam/docs/same.md", "a\n"),
      backend!.writeFile("/src/repos/sam/docs/same.md", "bbbb\n"),
    ]);

    const manifestObject = await storage.get(manifestKey);
    const manifest = JSON.parse(await manifestObject!.text()) as {
      changes: Record<string, { contentKey: string; size: number }>;
    };
    expect(manifest.changes["same.md"].size).toBe(2);
    await expect(storage.get(manifest.changes["same.md"].contentKey).then((object) => object?.text()))
      .resolves.toBe("a\n");
    await expect(backend!.readFile("/src/repos/sam/docs/same.md")).resolves.toBe("a\n");
    expect(storage.conditionalFailures).toBeGreaterThan(0);
  });

  it("does not delete a payload reintroduced while staged delete cleanup is pending", async () => {
    const cleanupStarted = makeDeferred();
    const releaseCleanup = makeDeferred();
    let blockCleanup = false;
    const storage = makeBucket({
      beforeDelete: async (key) => {
        if (!blockCleanup || !key.includes("/files/race.md")) {
          return;
        }
        blockCleanup = false;
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      },
    });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });
    await backend!.writeFile("/src/repos/sam/docs/race.md", "old\n");

    blockCleanup = true;
    const deleting = backend!.rm("/src/repos/sam/docs/race.md");
    await cleanupStarted.promise;
    await backend!.writeFile("/src/repos/sam/docs/race.md", "new\n");
    releaseCleanup.resolve();
    await deleting;

    await expect(backend!.readFile("/src/repos/sam/docs/race.md")).resolves.toBe("new\n");
    const status = await getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/docs")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: null,
    }, "sam/docs");
    expect(status.changes).toMatchObject([{ type: "put", path: "race.md", size: 4 }]);
  });

  it("preserves staging created while a repo commit is applying", async () => {
    const applyStarted = makeDeferred();
    const releaseApply = makeDeferred();
    const storage = makeBucket();
    const config = makeConfig();
    const repo = makeRepo("sam/docs");
    const readPath = async () => ({ kind: "missing" as const });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [repo],
      processId: "task:source",
      config,
      ripgit: { readPath } as any,
    });
    await backend!.writeFile("/src/repos/sam/docs/first.md", "first\n");

    const committing = commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [repo],
      processId: "task:source",
      config,
      ripgit: {
        readPath,
        refs: async () => ({ heads: { main: "mainhead" }, tags: {} }),
        apply: async () => {
          applyStarted.resolve();
          await releaseApply.promise;
          return { head: "committed-head" };
        },
      } as any,
    }, "sam/docs", { message: "commit first" });
    await applyStarted.promise;
    await backend!.writeFile("/src/repos/sam/docs/second.md", "second\n");
    releaseApply.resolve();

    const result = await committing;
    expect(result.changes.map((change) => change.path)).toEqual(["second.md"]);
    const remainingManifest = await storage.get(
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json",
    );
    await expect(remainingManifest!.text().then((body) => JSON.parse(body).baseRef))
      .resolves.toBe("committed-head");
    await expect(backend!.readFile("/src/repos/sam/docs/first.md")).rejects.toThrow("ENOENT");
    await expect(backend!.readFile("/src/repos/sam/docs/second.md")).resolves.toBe("second\n");
    const status = await getRepoSourceStatus({
      identity: IDENTITY,
      storage,
      repos: [repo],
      processId: "task:source",
      config,
      ripgit: null,
    }, "sam/docs");
    expect(status.changes.map((change) => change.path)).toEqual(["second.md"]);
  });

  it("does not let a stale standalone discard regress a concurrent commit base", async () => {
    const staleDiscardWaiting = makeDeferred();
    const releaseStaleDiscard = makeDeferred();
    const manifestKey =
      "process-source-overlays/task%3Asource/global%3Arepo%3Asam%2Fdocs/manifest.json";
    let blockStaleDiscard = true;
    const storage = makeBucket({
      beforePut: async (key, value) => {
        if (key !== manifestKey || !blockStaleDiscard) {
          return;
        }
        const manifest = JSON.parse(bucketValueText(value));
        if (manifest.baseRef === "head-one" && Object.keys(manifest.changes).length === 0) {
          blockStaleDiscard = false;
          staleDiscardWaiting.resolve();
          await releaseStaleDiscard.promise;
        }
      },
    });
    const config = makeConfig();
    config.set(
      "process-source-branches/task%3Asource/global%3Arepo%3Asam%2Fdocs",
      JSON.stringify({
        branch: "main",
        baseRef: "main",
        head: "head-one",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const repo = makeRepo("sam/docs");
    const readPath = async () => ({ kind: "missing" as const });
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [repo],
      processId: "task:source",
      config,
      ripgit: { readPath } as any,
    });
    await backend!.writeFile("/src/repos/sam/docs/first.md", "first\n");

    const discarding = discardRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [repo],
      processId: "task:source",
      config,
      ripgit: null,
    }, "sam/docs");
    await staleDiscardWaiting.promise;
    try {
      await commitRepoSourceChanges({
        identity: IDENTITY,
        storage,
        repos: [repo],
        processId: "task:source",
        config,
        ripgit: {
          readPath,
          apply: async () => ({ head: "head-two" }),
        } as any,
      }, "sam/docs", { message: "advance branch" });
    } finally {
      releaseStaleDiscard.resolve();
    }
    await discarding;

    const manifest = await storage.get(manifestKey);
    await expect(manifest!.text().then((body) => JSON.parse(body).baseRef))
      .resolves.toBe("head-two");
  });

  it("keeps public non-owned repos read-only through /src/repos", async () => {
    const applyCalls: any[] = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
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

  it("keeps package source repos visible under /src/repos from repo visibility", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [
        makeRepo("root/gsv", { kind: "package", public: false, writable: false }),
        makeRepo("root/gsv-manual", { kind: "user", public: true, writable: false }),
      ],
      processId: "task:source",
      config: makeConfig(),
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
      } as any,
    });

    await expect(backend!.readdir("/src/repos/root")).resolves.toEqual(["gsv", "gsv-manual"]);
    await expect(backend!.readFile("/src/repos/root/gsv/README.md")).resolves.toBe("gsv source\n");
    await expect(backend!.readFile("/src/repos/root/gsv/packages/chat/package.json")).resolves.toContain("chat");
  });

  it("reads package source repos at the package source ref", async () => {
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv", { kind: "package", writable: false, ref: "feature/review", baseRef: "commit123" })],
      processId: "task:source",
      config: makeConfig(),
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
      } as any,
    });

    await expect(backend!.readFile("/src/repos/root/gsv/packages/chat/package.json")).resolves.toContain("chat");
    expect(readCalls).toEqual([{
      repo: { owner: "root", repo: "gsv", branch: "commit123" },
      path: "packages/chat/package.json",
    }]);
  });

  it("selects package source refs by source subdirectory", async () => {
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv", {
        kind: "package",
        writable: false,
        ref: "feature/a",
        baseRef: "commit-a",
        sources: [
          {
            kind: "package",
            packageId: "pkg-a",
            name: "Package A",
            subdir: "packages/a",
            ref: "feature/a",
            baseRef: "commit-a",
          },
          {
            kind: "package",
            packageId: "pkg-b",
            name: "Package B",
            subdir: "packages/b",
            ref: "feature/b",
            baseRef: "commit-b",
          },
        ],
      })],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
          readCalls.push({ repo, path });
          if (repo.branch === "commit-b" && path === "packages/b/src/index.ts") {
            return {
              kind: "file",
              bytes: new TextEncoder().encode("export const b = true;\n"),
              size: 23,
            };
          }
          return { kind: "missing" };
        },
      } as any,
    });

    await expect(backend!.readFile("/src/repos/root/gsv/packages/b/src/index.ts")).resolves.toContain("b = true");
    expect(readCalls).toEqual([{
      repo: { owner: "root", repo: "gsv", branch: "commit-b" },
      path: "packages/b/src/index.ts",
    }]);
  });

  it("commits package source repos to the package source ref by default", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
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
    } as any;
    const repos = [makeRepo("sam/pkg-test", {
      kind: "package",
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
    const result = await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: update package" });

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
    expect(applyCalls[0][5]).toEqual({ baseRef: "commit123" });
  });

  it("locks default package source commits to the installed branch head", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
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
    } as any;
    const repos = [makeRepo("sam/pkg-test", {
      kind: "package",
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
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: update package" });

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

  it("commits the matching same-repo package source from --here paths", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const ripgit = {
      readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        return { kind: "missing" };
      },
      refs: async () => ({ heads: {}, tags: {} }),
      apply: async (...args: any[]) => {
        applyCalls.push(args);
        return { head: "feature-b-head" };
      },
    } as any;
    const repos = [makeRepo("sam/mono", {
      kind: "package",
      writable: true,
      ref: "feature/a",
      baseRef: "commit-a",
      sources: [
        {
          kind: "package",
          packageId: "pkg-a",
          name: "Package A",
          subdir: "packages/a",
          ref: "feature/a",
          baseRef: "commit-a",
        },
        {
          kind: "package",
          packageId: "pkg-b",
          name: "Package B",
          subdir: "packages/b",
          ref: "feature/b",
          baseRef: "commit-b",
        },
      ],
    })];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/mono/packages/b/src/index.ts", "export const b = true;\n");
    const result = await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos,
      processId: "task:source",
      config,
      ripgit,
    }, "sam/mono", {
      message: "repo: update package b",
      sourcePath: "/src/repos/sam/mono/packages/b",
    });

    expect(result).toMatchObject({
      sourceRef: "feature/b",
      baseRef: "commit-b",
      branch: "feature/b",
      head: "feature-b-head",
    });
    expect(readCalls).toEqual([{
      repo: { owner: "sam", repo: "mono", branch: "commit-b" },
      path: "packages/b/src/index.ts",
    }]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "mono",
      branch: "feature/b",
    });
    expect(applyCalls[0][5]).toEqual({ baseRef: "commit-b" });
  });

  it("reads package subdirectories through the canonical repo path", async () => {
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/mono")],
      processId: "task:source",
      config: makeConfig(),
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
      } as any,
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
    }, "sam/pkg-test", { message: "repo: commit one" });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/two.ts", "export const two = true;\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: commit two", branch: "feature/package-work" });

    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "feature/package-work",
    });
    expect(applyCalls[1][5]).toEqual({ baseRef: "processhead123" });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/three.ts", "export const three = true;\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: commit three" });

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
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const changed = true;\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: commit to existing branch", branch: "feature/package-work" });

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

  it("reads from the active process branch head after committing source changes", async () => {
    const config = makeConfig();
    const storage = makeBucket();
    const applyCalls: any[] = [];
    const readCalls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const filePath = "packages/sample-console/src/index.ts";
    const ripgit = {
      readPath: async (repo: { owner: string; repo: string; branch?: string }, path: string) => {
        readCalls.push({ repo, path });
        if (path !== filePath) {
          return { kind: "missing" };
        }
        const text = repo.branch === "processhead123" ? "branch\n" : "main\n";
        return {
          kind: "file",
          bytes: new TextEncoder().encode(text),
          size: text.length,
        };
      },
      refs: async () => ({ heads: {}, tags: {} }),
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

    await backend!.writeFile(`/src/repos/sam/pkg-test/${filePath}`, "branch\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: commit branch base", branch: "feature/package-work" });
    expect(readCalls).toEqual([{
      repo: { owner: "sam", repo: "pkg-test", branch: "main" },
      path: filePath,
    }]);

    readCalls.length = 0;
    await backend!.appendFile(`/src/repos/sam/pkg-test/${filePath}`, "next\n");
    await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: append on branch" });

    expect(readCalls.length).toBeGreaterThan(0);
    expect(readCalls.every((call) => call.repo.branch === "processhead123")).toBe(true);
    expect(applyCalls[1][4]).toEqual([{
      type: "put",
      path: filePath,
      contentBytes: Array.from(new TextEncoder().encode("branch\nnext\n")),
    }]);
    expect(applyCalls[1][5]).toEqual({ baseRef: "processhead123", expectedHead: "processhead123" });
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
    }, "sam/pkg-test", { message: "repo: commit one" });

    await backend!.writeFile("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts", "export const same = true;\n");
    const result = await commitRepoSourceChanges({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config,
      ripgit,
    }, "sam/pkg-test", { message: "repo: select feature", branch: "feature/package-work" });

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

  it("treats recursively deleted overlay directories as missing in readdir", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/pkg-test")],
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

    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).resolves.toEqual(["index.ts"]);
    await backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src", { recursive: true });

    await expect(backend!.stat("/src/repos/sam/pkg-test/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).rejects.toThrow("ENOENT");
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console")).resolves.toEqual([]);
  });

  it("preserves parent directories when deleting nested source files", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("sam/pkg-test")],
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

    await backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src/index.ts");

    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console")).resolves.toEqual(["src"]);
    await expect(backend!.readdir("/src/repos/sam/pkg-test/packages/sample-console/src")).resolves.toEqual(["other.ts"]);
  });

  it("rejects source rm for missing paths unless forced", async () => {
    const storage = makeBucket();
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage,
      repos: [makeRepo("sam/pkg-test")],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
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

    await expect(backend!.rm("/src/repos/sam/pkg-test/packages/sample-console/src"))
      .rejects.toThrow("ENOTEMPTY");
    expect(storage.objects.size).toBe(0);
  });

  it("keeps package sources from other owners read-only", async () => {
    const backend = createProcessSourceBackend({
      identity: IDENTITY,
      storage: makeBucket(),
      repos: [makeRepo("root/gsv", { kind: "package", writable: false })],
      processId: "task:source",
      config: makeConfig(),
      ripgit: {
        readPath: async () => ({ kind: "missing" }),
      } as any,
    });

    await expect(backend!.writeFile("/src/repos/root/gsv/packages/wiki/src/index.ts", "x")).rejects.toThrow("read-only");
  });
});
