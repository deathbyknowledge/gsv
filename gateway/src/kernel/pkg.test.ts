import { describe, expect, it, vi } from "vitest";
import gsvPackageInfo from "@humansandmachines/gsv/package.json";
import {
  handlePkgCreate,
  handlePkgInstall,
  handlePkgList,
  handlePkgPublicList,
  handlePkgPublicSet,
  handlePkgRemoteAdd,
  handlePkgRemoteList,
  handlePkgRemoteRemove,
  handlePkgRemove,
  handlePkgSync,
} from "./pkg";
import type { KernelContext } from "./context";

const GSV_SDK_PACKAGE_VERSION = gsvPackageInfo.version;

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function makeFetcher(handler: (url: URL, init?: RequestInit) => Response): Fetcher & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), init });
      return Promise.resolve(handler(url, init));
    },
  } as Fetcher & { calls: FetchCall[] };
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
    delete(key: string) {
      return values.delete(key);
    },
    list(prefix: string) {
      const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return [...values.entries()]
        .filter(([key]) => key.startsWith(normalized))
        .map(([key, value]) => ({ key, value }));
    },
    values,
  };
}

function parsePutPackageJson(applyBody: { ops?: unknown }): Record<string, unknown> {
  const ops = Array.isArray(applyBody.ops) ? applyBody.ops : [];
  const packageJsonOp = ops.find((op): op is { path: string; contentBytes: number[] } => (
    !!op &&
    typeof op === "object" &&
    (op as { path?: unknown }).path === "package.json" &&
    Array.isArray((op as { contentBytes?: unknown }).contentBytes)
  ));
  if (!packageJsonOp) {
    throw new Error("package.json scaffold op is missing");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(packageJsonOp.contentBytes))) as Record<string, unknown>;
}

function makeInstalledPackageRecord({
  packageId,
  name,
  sourceSubdir,
}: {
  packageId: string;
  name: string;
  sourceSubdir: string;
}) {
  return {
    packageId,
    scope: { kind: "global" },
    manifest: {
      name,
      displayName: name,
      description: "",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "root/gsv",
        ref: "main",
        subdir: sourceSubdir,
        resolvedCommit: "abc123",
      },
      entrypoints: [],
      capabilities: {},
    },
    artifact: {
      hash: "sha256:test",
      mainModule: "src/main.ts",
      modulePaths: [],
    },
    grants: {},
    enabled: true,
    reviewRequired: false,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
  };
}

function makeRootIdentity() {
  return {
    role: "user",
    capabilities: ["pkg.remove"],
    process: {
      uid: 0,
      gid: 0,
      gids: [0],
      username: "root",
      home: "/root",
      cwd: "/root",
    },
  };
}

describe("pkg syscalls", () => {
  it("stores public repo state as repo visibility metadata", () => {
    const config = makeConfig();
    const ctx = {
      config,
      identity: makeRootIdentity(),
    } as unknown as KernelContext;

    expect(handlePkgPublicSet({ repo: "alice/weather", public: true }, ctx)).toEqual({
      changed: true,
      repo: "alice/weather",
      public: true,
    });
    expect(config.get("repos/alice/weather/visibility")).toBe("public");

    expect(handlePkgPublicSet({ repo: "alice/weather", public: false }, ctx)).toEqual({
      changed: true,
      repo: "alice/weather",
      public: false,
    });
    expect(config.get("repos/alice/weather/visibility")).toBeNull();
  });

  it("requires a package id for package sync", async () => {
    await expect(handlePkgSync(undefined, {} as KernelContext)).rejects.toThrow("packageId is required");
  });

  it("surfaces profile capabilities in package summaries", () => {
    const record = {
      ...makeInstalledPackageRecord({
        packageId: "import:root/gsv:packages/wiki",
        name: "wiki",
        sourceSubdir: "packages/wiki",
      }),
      manifest: {
        ...makeInstalledPackageRecord({
          packageId: "import:root/gsv:packages/wiki",
          name: "wiki",
          sourceSubdir: "packages/wiki",
        }).manifest,
        profiles: [{
          name: "builder",
          displayName: "Wiki Builder",
          contextFiles: [],
          capabilities: ["fs.*", "shell.exec"],
        }],
      },
    };
    const ctx = {
      config: makeConfig(),
      packages: {
        list: vi.fn(() => [record]),
      },
      identity: makeRootIdentity(),
    } as unknown as KernelContext;

    expect(handlePkgList(undefined, ctx).packages[0].profiles).toEqual([
      expect.objectContaining({
        name: "builder",
        capabilities: ["fs.*", "shell.exec"],
      }),
    ]);
  });

  it("does not enable packages when package-agent provisioning fails", async () => {
    const record = {
      ...makeInstalledPackageRecord({
        packageId: "import:root/gsv:packages/wiki",
        name: "wiki",
        sourceSubdir: "packages/wiki",
      }),
      enabled: false,
      manifest: {
        ...makeInstalledPackageRecord({
          packageId: "import:root/gsv:packages/wiki",
          name: "wiki",
          sourceSubdir: "packages/wiki",
        }).manifest,
        profiles: [{
          name: "builder",
          displayName: "Wiki Builder",
          contextFiles: [],
          capabilities: [],
        }],
      },
    };
    const setEnabled = vi.fn();
    const ctx = {
      config: {
        ...makeConfig(),
        get: vi.fn(() => null),
      },
      packages: {
        resolve: vi.fn(() => record),
        setEnabled,
      },
      auth: {
        getPasswdByUsername: vi.fn((username: string) =>
          username === "wiki-builder"
            ? {
                username,
                uid: 2000,
                gid: 2000,
                gecos: "Existing Agent",
                home: `/home/${username}`,
                shell: "/bin/init",
              }
            : null,
        ),
      },
      identity: makeRootIdentity(),
    } as unknown as KernelContext;

    await expect(handlePkgInstall({ packageId: record.packageId }, ctx))
      .rejects.toThrow(/already exists/);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("resolves user-scoped packages through the owning human for agent-backed installs", async () => {
    let enabled = false;
    const record = {
      ...makeInstalledPackageRecord({
        packageId: "user:1000:wiki@1",
        name: "wiki",
        sourceSubdir: "packages/wiki",
      }),
      scope: { kind: "user", uid: 1000 } as const,
      enabled,
    };
    const resolve = vi.fn(() => ({ ...record, enabled }));
    const setEnabled = vi.fn(() => {
      enabled = true;
      return true;
    });
    const ctx = {
      config: makeConfig(),
      packages: {
        resolve,
        setEnabled,
      },
      procs: {
        getOwnerUid: vi.fn(() => 1000),
      },
      processId: "proc:agent",
      identity: {
        role: "user",
        capabilities: ["pkg.install"],
        process: {
          uid: 2000,
          gid: 2000,
          gids: [2000],
          username: "alice-agent",
          home: "/home/alice-agent",
          cwd: "/home/alice-agent",
        },
      },
    } as unknown as KernelContext;

    const result = await handlePkgInstall({ packageId: record.packageId }, ctx);

    expect(resolve).toHaveBeenCalledWith(record.packageId, [
      { kind: "user", uid: 1000 },
      { kind: "global" },
    ]);
    expect(setEnabled).toHaveBeenCalledWith(record.packageId, true, record.scope);
    expect(result.changed).toBe(true);
  });

  it("uses the owning human's package remotes for agent-backed package calls", async () => {
    const config = makeConfig();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://packages.example/public/packages");
      expect(init).toEqual({ headers: { Accept: "application/json" } });
      return Response.json({
        serverName: "team packages",
        packages: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = {
      config,
      processId: "proc:agent",
      procs: {
        getOwnerUid: vi.fn(() => 1000),
      },
      packages: {
        list: vi.fn(() => []),
      },
      identity: {
        role: "user",
        capabilities: ["pkg.remote.add", "pkg.remote.list", "pkg.remote.remove", "pkg.public.list"],
        process: {
          uid: 2000,
          gid: 2000,
          gids: [2000],
          username: "alice-agent",
          home: "/home/alice-agent",
          cwd: "/home/alice-agent",
        },
      },
    } as unknown as KernelContext;

    try {
      const added = handlePkgRemoteAdd({
        name: "team",
        baseUrl: "https://packages.example/",
      }, ctx);

      expect(added).toMatchObject({
        changed: true,
        remote: { name: "team", baseUrl: "https://packages.example" },
        remotes: [{ name: "team", baseUrl: "https://packages.example" }],
      });
      expect(config.get("users/1000/pkg/remotes/team")).toBe("https://packages.example");
      expect(config.get("users/2000/pkg/remotes/team")).toBeNull();
      expect(handlePkgRemoteList(undefined, ctx).remotes).toEqual([
        { name: "team", baseUrl: "https://packages.example" },
      ]);

      const publicList = await handlePkgPublicList({ remote: "team" }, ctx);
      expect(publicList).toMatchObject({
        serverName: "team packages",
        source: { kind: "remote", name: "team", baseUrl: "https://packages.example" },
        packages: [],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(handlePkgRemoteRemove({ name: "team" }, ctx)).toEqual({
        removed: true,
        remotes: [],
      });
      expect(config.get("users/1000/pkg/remotes/team")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows removing a former builtin GSV console package", async () => {
    let enabled = true;
    const record = makeInstalledPackageRecord({
      packageId: "builtin:gsv@0.1.0",
      name: "gsv",
      sourceSubdir: "packages/gsv",
    });
    const setEnabled = vi.fn(() => {
      enabled = false;
      return true;
    });
    const ctx = {
      config: makeConfig(),
      packages: {
        resolve: vi.fn(() => ({ ...record, enabled })),
        setEnabled,
      },
      identity: makeRootIdentity(),
    } as unknown as KernelContext;

    await expect(handlePkgRemove({ packageId: record.packageId }, ctx)).resolves.toMatchObject({
      changed: true,
      package: {
        packageId: "builtin:gsv@0.1.0",
        enabled: false,
      },
    });
    expect(setEnabled).toHaveBeenCalledWith(record.packageId, false, record.scope);
  });

  it("scaffolds a user-owned package repo and installs the resolved package", async () => {
    const fetcher = makeFetcher((url, init) => {
      if (url.pathname === "/hyperspace/repos/alice/weather/refs") {
        return Response.json({ heads: {}, tags: {} });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/read") {
        if (url.searchParams.get("path") === ".") {
          expect(url.searchParams.get("ref")).toBe("main");
        }
        return new Response("missing", { status: 404 });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/apply") {
        expect(init?.method).toBe("POST");
        return Response.json({ ok: true, head: "head123", conflict: false });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/analyze") {
        expect(url.searchParams.get("ref")).toBe("main");
        expect(url.searchParams.get("subdir")).toBe(".");
        return Response.json({
          ok: true,
          source: {
            repo: "alice/weather",
            ref: "main",
            resolved_commit: "head123",
            subdir: ".",
          },
          package_root: ".",
          identity: {
            package_json_name: "@alice/weather",
            version: "0.1.0",
            display_name: "Weather Desk",
          },
          package_json: {
            name: "@alice/weather",
            version: "0.1.0",
            type: "module",
            dependencies: { "@humansandmachines/gsv": GSV_SDK_PACKAGE_VERSION },
            dev_dependencies: {},
          },
          definition: {
            meta: {
              display_name: "Weather Desk",
              description: "Weather command center.",
              icon: null,
              window: {
                width: 1040,
                height: 720,
                min_width: 720,
                min_height: 480,
              },
              capabilities: {
                kernel: [],
                outbound: [],
              },
            },
            commands: [],
            browser: {
              entry: "./src/main.ts",
              assets: ["./src/styles.css"],
            },
            backend: null,
          },
          diagnostics: [],
          analysis_hash: "analysis123",
        });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/snapshot") {
        expect(url.searchParams.get("ref")).toBe("head123");
        return Response.json({
          source: {
            repo: "alice/weather",
            ref: "main",
            resolved_commit: "head123",
            subdir: ".",
          },
          package_root: ".",
          files: {
            "package.json": "{}",
            "src/package.ts": "export default {};",
            "src/main.ts": "export {};",
          },
        });
      }
      throw new Error(`unexpected ripgit request: ${url.pathname}`);
    });

    const install = vi.fn(async (input) => ({
      packageId: input.packageId,
      scope: input.scope,
      manifest: input.manifest,
      artifact: {
        hash: input.artifact.hash,
        mainModule: input.artifact.mainModule,
        modulePaths: input.artifact.modules.map((module: { path: string }) => module.path),
      },
      grants: input.grants,
      enabled: input.enabled,
      reviewRequired: input.reviewRequired,
      reviewedAt: input.reviewedAt,
      installedAt: input.installedAt ?? 1,
      updatedAt: input.updatedAt ?? 2,
    }));
    const config = makeConfig();
    const ctx = {
      env: {
        RIPGIT: fetcher,
        ASSEMBLER: {
          assemblePackage: vi.fn(async () => ({
            ok: true,
            source: {
              repo: "alice/weather",
              ref: "main",
              resolved_commit: "head123",
              subdir: ".",
            },
            analysis_hash: "analysis123",
            target: "dynamic-worker",
            artifact: {
              hash: "sha256:weather",
              main_module: "src/main.ts",
              modules: [
                { path: "src/main.ts", kind: "source-module", content: "export {};" },
              ],
            },
            diagnostics: [],
          })),
        },
      },
      config,
      packages: {
        get: vi.fn(() => null),
        install,
      },
      identity: {
        role: "user",
        capabilities: ["pkg.create"],
        process: {
          uid: 1000,
          gid: 100,
          gids: [100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
      },
    } as unknown as KernelContext;

    const result = await handlePkgCreate({
      repo: "weather",
      displayName: "Weather Desk",
      description: "Weather command center.",
      enable: true,
    }, ctx);

    expect(result).toMatchObject({
      changed: true,
      created: true,
      repo: "alice/weather",
      ref: "main",
      subdir: ".",
      head: "head123",
      package: {
        packageId: "import:alice/weather:.",
        name: "weather",
        enabled: true,
        review: { required: false },
      },
    });
    expect(result.files).toEqual([
      "package.json",
      "src/package.ts",
      "src/main.ts",
      "src/styles.css",
      "README.md",
    ]);
    const applyCall = fetcher.calls.find((call) => new URL(call.url).pathname.endsWith("/apply"));
    const applyBody = JSON.parse(String(applyCall?.init?.body));
    expect(applyBody.message).toBe("pkg: create @alice/weather");
    expect(applyBody.ops.map((op: { path: string }) => op.path)).toContain("src/package.ts");
    expect(parsePutPackageJson(applyBody)).toMatchObject({
      dependencies: {
        "@humansandmachines/gsv": GSV_SDK_PACKAGE_VERSION,
      },
    });
    expect(applyBody.baseRef).toBeUndefined();
    expect(config.get("repos/alice/weather/description")).toBe("Weather command center.");
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      packageId: "import:alice/weather:.",
      enabled: true,
      reviewRequired: false,
    }));
  });

  it("bases a new package ref on the repo default branch", async () => {
    const fetcher = makeFetcher((url, init) => {
      if (url.pathname === "/hyperspace/repos/alice/weather/refs") {
        return Response.json({ heads: { main: "mainhead123" }, tags: {} });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/read") {
        if (url.searchParams.get("path") === ".") {
          expect(url.searchParams.get("ref")).toBe("main");
        }
        return new Response("missing", { status: 404 });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/apply") {
        expect(init?.method).toBe("POST");
        return Response.json({ ok: true, head: "featurehead123", conflict: false });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/analyze") {
        expect(url.searchParams.get("ref")).toBe("feature-x");
        expect(url.searchParams.get("subdir")).toBe(".");
        return Response.json({
          ok: true,
          source: {
            repo: "alice/weather",
            ref: "feature-x",
            resolved_commit: "featurehead123",
            subdir: ".",
          },
          package_root: ".",
          identity: {
            package_json_name: "@alice/weather",
            version: "0.1.0",
            display_name: "Weather Desk",
          },
          package_json: {
            name: "@alice/weather",
            version: "0.1.0",
            type: "module",
            dependencies: { "@humansandmachines/gsv": GSV_SDK_PACKAGE_VERSION },
            dev_dependencies: {},
          },
          definition: {
            meta: {
              display_name: "Weather Desk",
              description: "Weather command center.",
              icon: null,
              window: {
                width: 1040,
                height: 720,
                min_width: 720,
                min_height: 480,
              },
              capabilities: {
                kernel: [],
                outbound: [],
              },
            },
            commands: [],
            browser: {
              entry: "./src/main.ts",
              assets: ["./src/styles.css"],
            },
            backend: null,
          },
          diagnostics: [],
          analysis_hash: "analysis123",
        });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/snapshot") {
        expect(url.searchParams.get("ref")).toBe("featurehead123");
        return Response.json({
          source: {
            repo: "alice/weather",
            ref: "feature-x",
            resolved_commit: "featurehead123",
            subdir: ".",
          },
          package_root: ".",
          files: {
            "package.json": "{}",
            "src/package.ts": "export default {};",
            "src/main.ts": "export {};",
          },
        });
      }
      throw new Error(`unexpected ripgit request: ${url.pathname}`);
    });

    const install = vi.fn(async (input) => ({
      packageId: input.packageId,
      scope: input.scope,
      manifest: input.manifest,
      artifact: {
        hash: input.artifact.hash,
        mainModule: input.artifact.mainModule,
        modulePaths: input.artifact.modules.map((module: { path: string }) => module.path),
      },
      grants: input.grants,
      enabled: input.enabled,
      reviewRequired: input.reviewRequired,
      reviewedAt: input.reviewedAt,
      installedAt: input.installedAt ?? 1,
      updatedAt: input.updatedAt ?? 2,
    }));
    const ctx = {
      env: {
        RIPGIT: fetcher,
        ASSEMBLER: {
          assemblePackage: vi.fn(async () => ({
            ok: true,
            source: {
              repo: "alice/weather",
              ref: "feature-x",
              resolved_commit: "featurehead123",
              subdir: ".",
            },
            analysis_hash: "analysis123",
            target: "dynamic-worker",
            artifact: {
              hash: "sha256:weather",
              main_module: "src/main.ts",
              modules: [
                { path: "src/main.ts", kind: "source-module", content: "export {};" },
              ],
            },
            diagnostics: [],
          })),
        },
      },
      config: makeConfig(),
      packages: {
        get: vi.fn(() => null),
        install,
      },
      identity: {
        role: "user",
        capabilities: ["pkg.create"],
        process: {
          uid: 1000,
          gid: 100,
          gids: [100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
      },
    } as unknown as KernelContext;

    const result = await handlePkgCreate({
      repo: "weather",
      ref: "feature-x",
      displayName: "Weather Desk",
      description: "Weather command center.",
      enable: true,
    }, ctx);

    expect(result).toMatchObject({
      created: true,
      repo: "alice/weather",
      ref: "feature-x",
      head: "featurehead123",
    });
    const applyCall = fetcher.calls.find((call) => new URL(call.url).pathname.endsWith("/apply"));
    const applyBody = JSON.parse(String(applyCall?.init?.body));
    expect(applyBody.baseRef).toBe("main");
  });

  it("bases missing main package creation on an existing branch", async () => {
    const fetcher = makeFetcher((url, init) => {
      if (url.pathname === "/hyperspace/repos/alice/weather/refs") {
        return Response.json({ heads: { master: "masterhead123" }, tags: {} });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/read") {
        if (url.searchParams.get("path") === ".") {
          expect(url.searchParams.get("ref")).toBe("master");
        }
        return new Response("missing", { status: 404 });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/apply") {
        expect(init?.method).toBe("POST");
        return Response.json({ ok: true, head: "mainhead123", conflict: false });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/analyze") {
        expect(url.searchParams.get("ref")).toBe("main");
        expect(url.searchParams.get("subdir")).toBe(".");
        return Response.json({
          ok: true,
          source: {
            repo: "alice/weather",
            ref: "main",
            resolved_commit: "mainhead123",
            subdir: ".",
          },
          package_root: ".",
          identity: {
            package_json_name: "@alice/weather",
            version: "0.1.0",
            display_name: "Weather Desk",
          },
          package_json: {
            name: "@alice/weather",
            version: "0.1.0",
            type: "module",
            dependencies: { "@humansandmachines/gsv": GSV_SDK_PACKAGE_VERSION },
            dev_dependencies: {},
          },
          definition: {
            meta: {
              display_name: "Weather Desk",
              description: "Weather command center.",
              icon: null,
              window: {
                width: 1040,
                height: 720,
                min_width: 720,
                min_height: 480,
              },
              capabilities: {
                kernel: [],
                outbound: [],
              },
            },
            commands: [],
            browser: {
              entry: "./src/main.ts",
              assets: ["./src/styles.css"],
            },
            backend: null,
          },
          diagnostics: [],
          analysis_hash: "analysis123",
        });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/packages/snapshot") {
        expect(url.searchParams.get("ref")).toBe("mainhead123");
        return Response.json({
          source: {
            repo: "alice/weather",
            ref: "main",
            resolved_commit: "mainhead123",
            subdir: ".",
          },
          package_root: ".",
          files: {
            "package.json": "{}",
            "src/package.ts": "export default {};",
            "src/main.ts": "export {};",
          },
        });
      }
      throw new Error(`unexpected ripgit request: ${url.pathname}`);
    });

    const install = vi.fn(async (input) => ({
      packageId: input.packageId,
      scope: input.scope,
      manifest: input.manifest,
      artifact: {
        hash: input.artifact.hash,
        mainModule: input.artifact.mainModule,
        modulePaths: input.artifact.modules.map((module: { path: string }) => module.path),
      },
      grants: input.grants,
      enabled: input.enabled,
      reviewRequired: input.reviewRequired,
      reviewedAt: input.reviewedAt,
      installedAt: input.installedAt ?? 1,
      updatedAt: input.updatedAt ?? 2,
    }));
    const ctx = {
      env: {
        RIPGIT: fetcher,
        ASSEMBLER: {
          assemblePackage: vi.fn(async () => ({
            ok: true,
            source: {
              repo: "alice/weather",
              ref: "main",
              resolved_commit: "mainhead123",
              subdir: ".",
            },
            analysis_hash: "analysis123",
            target: "dynamic-worker",
            artifact: {
              hash: "sha256:weather",
              main_module: "src/main.ts",
              modules: [
                { path: "src/main.ts", kind: "source-module", content: "export {};" },
              ],
            },
            diagnostics: [],
          })),
        },
      },
      config: makeConfig(),
      packages: {
        get: vi.fn(() => null),
        install,
      },
      identity: {
        role: "user",
        capabilities: ["pkg.create"],
        process: {
          uid: 1000,
          gid: 100,
          gids: [100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
      },
    } as unknown as KernelContext;

    const result = await handlePkgCreate({
      repo: "weather",
      displayName: "Weather Desk",
      description: "Weather command center.",
      enable: true,
    }, ctx);

    expect(result).toMatchObject({
      created: true,
      repo: "alice/weather",
      ref: "main",
      head: "mainhead123",
    });
    const applyCall = fetcher.calls.find((call) => new URL(call.url).pathname.endsWith("/apply"));
    const applyBody = JSON.parse(String(applyCall?.init?.body));
    expect(applyBody.baseRef).toBe("master");
  });

  it("refuses to scaffold into a non-empty directory without overwrite", async () => {
    const fetcher = makeFetcher((url) => {
      if (url.pathname === "/hyperspace/repos/alice/weather/refs") {
        return Response.json({ heads: { main: "mainhead123" }, tags: {} });
      }
      if (url.pathname === "/hyperspace/repos/alice/weather/read") {
        expect(url.searchParams.get("path")).toBe(".");
        return Response.json([
          { name: "README.md", mode: "100644", hash: "readme1", type: "blob" },
        ]);
      }
      throw new Error(`unexpected ripgit request: ${url.pathname}`);
    });
    const install = vi.fn();
    const ctx = {
      env: {
        RIPGIT: fetcher,
      },
      config: makeConfig(),
      packages: {
        get: vi.fn(() => null),
        install,
      },
      identity: {
        role: "user",
        capabilities: ["pkg.create"],
        process: {
          uid: 1000,
          gid: 100,
          gids: [100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
      },
    } as unknown as KernelContext;

    await expect(handlePkgCreate({
      repo: "weather",
      displayName: "Weather Desk",
      description: "Weather command center.",
    }, ctx)).rejects.toThrow(
      "Package source path is not empty at alice/weather:.",
    );
    expect(fetcher.calls.some((call) => new URL(call.url).pathname.endsWith("/apply"))).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });
});
