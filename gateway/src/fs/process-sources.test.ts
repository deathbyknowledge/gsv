import { describe, expect, it } from "vitest";
import { createProcessSourceBackend } from "./index";
import type { ProcessIdentity } from "../syscalls/system";
import type { ProcessMount } from "../kernel/processes";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

describe("createProcessSourceBackend", () => {
  it("normalizes dot subdirs and reads mounted package files from the named ref", async () => {
    const calls: Array<{ repo: { owner: string; repo: string; branch?: string }; path: string }> = [];
    const backend = createProcessSourceBackend(
      IDENTITY,
      {
        readPath: async (repo, path) => {
          calls.push({ repo, path });
          if (path === "") {
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
      [
        {
          kind: "ripgit-source",
          mountPath: "/src/package",
          packageId: "import:root/pkg-test:.",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: "deadbeef",
          subdir: ".",
        } satisfies ProcessMount,
      ],
    );

    expect(backend).not.toBeNull();
    await expect(backend!.readdir("/src/package")).resolves.toEqual(["src"]);
    await expect(backend!.readFile("/src/package/src/index.ts")).resolves.toContain("ok = true");

    expect(calls).toEqual([
      {
        repo: { owner: "root", repo: "pkg-test", branch: "main" },
        path: "",
      },
      {
        repo: { owner: "root", repo: "pkg-test", branch: "main" },
        path: "src/index.ts",
      },
    ]);
  });

  it("mounts package subdirs under /src/package while keeping /src/repo at repo root", async () => {
    const calls: string[] = [];
    const backend = createProcessSourceBackend(
      IDENTITY,
      {
        readPath: async (_repo, path) => {
          calls.push(path);
          return {
            kind: "tree",
            entries: [],
          };
        },
      } as any,
      [
        {
          kind: "ripgit-source",
          mountPath: "/src/package",
          packageId: "import:root/pkg-test:packages/ascii-starfield",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: null,
          subdir: "packages/ascii-starfield",
        } satisfies ProcessMount,
        {
          kind: "ripgit-source",
          mountPath: "/src/repo",
          packageId: "import:root/pkg-test:packages/ascii-starfield",
          repo: "root/pkg-test",
          ref: "main",
          resolvedCommit: null,
          subdir: ".",
        } satisfies ProcessMount,
      ],
    );

    await backend!.readdir("/src/package");
    await backend!.readdir("/src/repo");

    expect(calls).toEqual([
      "packages/ascii-starfield",
      "",
    ]);
  });
});
