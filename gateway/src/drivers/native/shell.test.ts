import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleShellExec } from "./shell";
import type { KernelContext } from "../../kernel/context";
import type { ProcessIdentity } from "../../syscalls/system";
import type { InstalledPackageRecord } from "../../kernel/packages";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000, 100],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

function makePackage(partial?: Partial<InstalledPackageRecord>): InstalledPackageRecord {
  return {
    packageId: "import:root/pkg-test:.",
    manifest: {
      name: "ascii-starfield",
      description: "ASCII starfield",
      version: "0.1.0",
      runtime: "dynamic-worker",
      source: {
        repo: "root/pkg-test",
        ref: "main",
        subdir: ".",
        resolvedCommit: "abc123",
      },
      entrypoints: [{ name: "Starfield", kind: "ui" }],
      bindingNames: ["PACKAGE"],
    },
    artifact: { hash: "hash1", mainModule: "index.js", modules: [] },
    grants: {
      kernel: ["pkg.repo.refs", "pkg.repo.log"],
      outbound: [],
    },
    enabled: false,
    reviewRequired: true,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
    ...partial,
  } as InstalledPackageRecord;
}

function makeContext(options?: {
  capabilities?: string[];
  mounts?: Array<{ mountPath: string; packageId: string }>;
  pkg?: InstalledPackageRecord;
}): KernelContext {
  const pkg = options?.pkg ?? makePackage();
  const records = new Map([[pkg.packageId, pkg]]);
  return {
    env: {
      STORAGE: env.STORAGE,
      RIPGIT: {} as Fetcher,
      LOADER: { get() { throw new Error("LOADER should not be used in pkg shell tests"); } },
    } as unknown as Env,
    auth: null as never,
    caps: null as never,
    config: {
      get(key: string) {
        if (key === "config/server/name") return "gsv";
        if (key === "config/server/version") return "0.0.1";
        return null;
      },
    } as never,
    devices: null as never,
    procs: {
      getMounts() {
        return (options?.mounts ?? []).map((mount) => ({
          kind: "ripgit-source",
          mountPath: mount.mountPath,
          packageId: mount.packageId,
          repo: pkg.manifest.source.repo,
          ref: pkg.manifest.source.ref,
          resolvedCommit: pkg.manifest.source.resolvedCommit ?? null,
          subdir: mount.mountPath === "/src/package" ? pkg.manifest.source.subdir : ".",
        }));
      },
    } as never,
    workspaces: null as never,
    packages: {
      list() {
        return [...records.values()];
      },
      get(packageId: string) {
        return records.get(packageId) ?? null;
      },
      setEnabled(packageId: string, enabled: boolean) {
        const existing = records.get(packageId);
        if (!existing) return null;
        const updated = { ...existing, enabled, updatedAt: existing.updatedAt + 1 };
        records.set(packageId, updated);
        return updated;
      },
      setReviewed(packageId: string, reviewedAt: number) {
        const existing = records.get(packageId);
        if (!existing) return null;
        const updated = { ...existing, reviewedAt, reviewRequired: true, updatedAt: existing.updatedAt + 1 };
        records.set(packageId, updated);
        return updated;
      },
    } as never,
    adapters: null as never,
    runRoutes: null as never,
    connection: null as never,
    identity: {
      role: "user",
      process: IDENTITY,
      capabilities: options?.capabilities ?? ["pkg.list", "pkg.repo.refs", "pkg.repo.log"],
    },
    processId: "task:pkg",
    serverVersion: "0.0.1",
  } as KernelContext;
}

describe("pkg shell command", () => {
  it("defaults to the mounted package for manifest inspection", async () => {
    const result = await handleShellExec(
      { command: "pkg manifest", workdir: "/src/package" },
      makeContext({ mounts: [{ mountPath: "/src/package", packageId: "import:root/pkg-test:." }] }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('"name": "ascii-starfield"');
    expect(result.stderr).toBe("");
  });

  it("shows review status in pkg list output", async () => {
    const result = await handleShellExec(
      { command: "pkg list" },
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ascii-starfield");
    expect(result.stdout).toContain("pending");
  });

  it("enables an approved package through pkg enable", async () => {
    const result = await handleShellExec(
      { command: "pkg enable" },
      makeContext({
        capabilities: ["pkg.install"],
        mounts: [{ mountPath: "/src/package", packageId: "import:root/pkg-test:." }],
        pkg: makePackage({ reviewedAt: 100, reviewRequired: true }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("enabled ascii-starfield");
    expect(result.stderr).toBe("");
  });
});
