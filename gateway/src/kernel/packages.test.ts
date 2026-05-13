import { describe, expect, it, vi } from "vitest";
import type { PackageAssemblyRequest } from "@gsv/protocol/package-assembly";
import { buildBuiltinPackageSeeds } from "./packages";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function makeRipgitFetcher(): Fetcher & { analyzedSubdirs: string[]; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const analyzedSubdirs: string[] = [];
  const packageDirs = new Set(["chat", "starfield"]);

  return {
    calls,
    analyzedSubdirs,
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), init });

      if (url.pathname === "/hyperspace/repos/root/gsv/read") {
        const path = url.searchParams.get("path");
        if (path === "builtin-packages") {
          return Promise.resolve(Response.json([
            { name: "chat", mode: "40000", hash: "tree-chat", type: "tree" },
            { name: "README.md", mode: "100644", hash: "blob-readme", type: "blob" },
            { name: "social", mode: "40000", hash: "tree-social", type: "tree" },
            { name: "starfield", mode: "40000", hash: "tree-starfield", type: "tree" },
          ]));
        }

        const match = /^builtin-packages\/([^/]+)\/package\.json$/.exec(path ?? "");
        if (match && packageDirs.has(match[1])) {
          return Promise.resolve(new Response("{}", {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "x-blob-size": "2",
            },
          }));
        }

        return Promise.resolve(new Response("missing", { status: 404 }));
      }

      if (url.pathname === "/hyperspace/repos/root/gsv/packages/analyze") {
        const subdir = url.searchParams.get("subdir") ?? "";
        const name = subdir.split("/").at(-1) ?? "package";
        analyzedSubdirs.push(subdir);
        return Promise.resolve(Response.json(makeAnalyzeResponse(name, subdir)));
      }

      if (url.pathname === "/hyperspace/repos/root/gsv/packages/snapshot") {
        const subdir = url.searchParams.get("subdir") ?? "";
        return Promise.resolve(Response.json({
          source: {
            repo: "root/gsv",
            ref: "main",
            resolved_commit: "commit123",
            subdir,
          },
          package_root: subdir,
          files: {
            "src/package.ts": "export default {};",
          },
        }));
      }

      return Promise.resolve(new Response("not found", { status: 404 }));
    },
  } as Fetcher & { analyzedSubdirs: string[]; calls: FetchCall[] };
}

function makeAnalyzeResponse(name: string, subdir: string) {
  const kernel = name === "chat" ? ["proc.spawn"] : [];
  return {
    ok: true,
    source: {
      repo: "root/gsv",
      ref: "main",
      resolved_commit: "commit123",
      subdir,
    },
    package_root: subdir,
    identity: {
      package_json_name: `@gsv/${name}`,
      version: "0.1.0",
      display_name: name,
    },
    package_json: {
      name: `@gsv/${name}`,
      version: "0.1.0",
      type: "module",
      dependencies: {},
      dev_dependencies: {},
    },
    definition: {
      meta: {
        display_name: name,
        description: `${name} package`,
        icon: null,
        window: null,
        capabilities: {
          kernel,
          outbound: [],
        },
      },
      commands: [],
      browser: {
        entry: "./src/main.tsx",
        assets: [],
      },
      backend: kernel.length > 0
        ? {
            entry: "./src/backend.ts",
            public_routes: [],
          }
        : null,
    },
    diagnostics: [],
    analysis_hash: `analysis-${name}`,
  };
}

function makeAssembler() {
  return {
    fetch: vi.fn(),
    assemblePackage: vi.fn(async (input: PackageAssemblyRequest) => ({
      ok: true,
      source: input.analysis.source,
      analysis_hash: input.analysis.analysis_hash,
      target: input.target,
      diagnostics: [],
      artifact: {
        hash: `artifact-${input.analysis.package_json.name}`,
        main_module: "main.js",
        modules: [
          {
            path: "main.js",
            kind: "source-module" as const,
            content: "export default {};",
          },
        ],
      },
    })),
  };
}

describe("builtin package resolution", () => {
  it("discovers builtin packages from root/gsv and skips directories without package.json", async () => {
    const ripgit = makeRipgitFetcher();
    const assembler = makeAssembler();

    const seeds = await buildBuiltinPackageSeeds({
      RIPGIT: ripgit,
      ASSEMBLER: assembler,
    } as unknown as Env);

    expect(seeds.map((seed) => seed.manifest.name)).toEqual(["chat", "starfield"]);
    expect(ripgit.analyzedSubdirs.sort()).toEqual([
      "builtin-packages/chat",
      "builtin-packages/starfield",
    ]);
    expect(assembler.assemblePackage).toHaveBeenCalledTimes(2);
    expect(seeds.find((seed) => seed.manifest.name === "chat")?.grants).toEqual({
      bindings: [
        {
          binding: "KERNEL",
          providerKind: "kernel-entrypoint",
          providerRef: "kernel://app/request",
        },
      ],
      egress: {
        mode: "none",
      },
    });
    expect(seeds.find((seed) => seed.manifest.name === "starfield")?.grants).toEqual({
      egress: {
        mode: "none",
      },
    });
  });
});
