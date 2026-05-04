import { describe, expect, it, vi } from "vitest";
import { handlePkgCreate } from "./pkg";
import type { KernelContext } from "./context";

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

describe("pkg syscalls", () => {
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
            dependencies: { "@gsv/package": "^0.1.0" },
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
          workspaceId: null,
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
            dependencies: { "@gsv/package": "^0.1.0" },
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
          workspaceId: null,
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
            dependencies: { "@gsv/package": "^0.1.0" },
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
          workspaceId: null,
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
          workspaceId: null,
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
