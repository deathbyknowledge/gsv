import { describe, expect, it } from "vitest";
import { commitProcessSourceChanges, createProcessSourceBackend } from "./index";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { InstalledPackageRecord } from "../kernel/packages";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:sam/pkg-test:packages/ascii-starfield",
    scope: { kind: "user", uid: 1000 },
    manifest: {
      name: "ascii-starfield",
      description: "ASCII starfield",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "sam/pkg-test",
        ref: "main",
        subdir: "packages/ascii-starfield",
        resolvedCommit: "base123",
      },
      entrypoints: [{ name: "Starfield", kind: "ui", module: "main.js", route: "/apps/ascii-starfield" }],
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
          if (path === "packages/ascii-starfield") {
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
    await expect(backend!.readdir("/src/packages")).resolves.toEqual(["ascii-starfield"]);
    await expect(backend!.readdir("/src/packages/ascii-starfield")).resolves.toEqual(["src"]);
    await expect(backend!.readFile("/src/packages/ascii-starfield/src/index.ts")).resolves.toContain("ok = true");

    expect(calls).toEqual([
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/ascii-starfield",
      },
      {
        repo: { owner: "sam", repo: "pkg-test", branch: "base123" },
        path: "packages/ascii-starfield/src/index.ts",
      },
    ]);
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

    await backend!.writeFile("/src/packages/ascii-starfield/src/index.ts", "export const changed = true;\n");

    expect(applyCalls).toHaveLength(0);
    await expect(backend!.readFile("/src/packages/ascii-starfield/src/index.ts")).resolves.toContain("changed = true");

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
      branch: "gsv/process/task-source/ascii-starfield",
      commitHead: "processhead123",
      ops: 1,
      changes: [],
    });
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0][0]).toEqual({
      owner: "sam",
      repo: "pkg-test",
      branch: "gsv/process/task-source/ascii-starfield",
    });
    expect(applyCalls[0][5]).toEqual({ baseRef: "base123" });
    expect(applyCalls[0][4]).toEqual([
      {
        type: "put",
        path: "packages/ascii-starfield/src/index.ts",
        contentBytes: Array.from(new TextEncoder().encode("export const changed = true;\n")),
      },
    ]);

    const [state] = [...config.values.values()];
    expect(JSON.parse(state).branch).toBe("gsv/process/task-source/ascii-starfield");
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
