import { describe, expect, it } from "vitest";
import type { KernelContext } from "./context";
import {
  handleRepoApply,
  handleRepoCompare,
  handleRepoCreate,
  handleRepoRead,
} from "./repo";

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

function makeConfig(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
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
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }));
    },
    values,
  };
}

function makeContext(
  fetcher: Fetcher,
  configSeed: Record<string, string> = {},
  packages: Array<{ manifest: { source: { repo: string } } }> = [],
): KernelContext {
  const config = makeConfig(configSeed);
  return {
    env: {
      RIPGIT: fetcher,
    } as Env,
    config,
    identity: {
      role: "user",
      capabilities: ["repo.apply", "repo.compare", "repo.create", "repo.read"],
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
    packages: {
      list: () => packages,
    },
    workspaces: {
      list: () => [],
    },
  } as unknown as KernelContext;
}

describe("repo syscalls", () => {
  it("applies atomic repo changes through ripgit and records repo metadata", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/demo/apply");
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, head: "abc123", conflict: false });
    });
    const ctx = makeContext(fetcher);

    const result = await handleRepoApply({
      repo: "alice/demo",
      ref: "feature/docs",
      message: "docs: update guide",
      expectedHead: "old123",
      ops: [
        { type: "put", path: "docs/guide.md", content: "# Guide\n" },
        { type: "delete", path: "tmp", recursive: true },
      ],
    }, ctx);

    expect(result).toEqual({
      ok: true,
      repo: "alice/demo",
      ref: "feature/docs",
      head: "abc123",
    });
    const body = JSON.parse(String(fetcher.calls[0].init?.body));
    expect(body).toMatchObject({
      defaultBranch: "feature/docs",
      author: "alice",
      email: "alice@gsv.local",
      message: "docs: update guide",
      expectedHead: "old123",
    });
    expect(body.ops).toEqual([
      { type: "put", path: "docs/guide.md", contentBytes: [35, 32, 71, 117, 105, 100, 101, 10] },
      { type: "delete", path: "tmp", recursive: true },
    ]);
    expect(ctx.config.get("repos/alice/demo/created_at")).not.toBeNull();
    expect(ctx.config.get("repos/alice/demo/updated_at")).not.toBeNull();
  });

  it("creates a repository with an empty initial commit", async () => {
    const fetcher = makeFetcher((url, init) => {
      if (url.pathname === "/hyperspace/repos/alice/empty/refs") {
        return Response.json({ heads: {}, tags: {} });
      }
      expect(url.pathname).toBe("/hyperspace/repos/alice/empty/apply");
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, head: "created123", conflict: false });
    });
    const ctx = makeContext(fetcher);

    const result = await handleRepoCreate({
      repo: "alice/empty",
      description: "Empty repo",
    }, ctx);

    expect(result).toEqual({
      repo: "alice/empty",
      ref: "main",
      head: "created123",
      created: true,
    });
    const body = JSON.parse(String(fetcher.calls[1].init?.body));
    expect(body).toMatchObject({
      defaultBranch: "main",
      message: "repo: create alice/empty",
      ops: [],
      allowEmpty: true,
    });
    expect(ctx.config.get("repos/alice/empty/description")).toBe("Empty repo");
  });

  it("denies private repos owned by another user", async () => {
    const ctx = makeContext(makeFetcher(() => {
      throw new Error("ripgit should not be called");
    }));

    await expect(handleRepoRead({
      repo: "bob/private",
      path: "README.md",
    }, ctx)).rejects.toThrow("Forbidden: cannot read repo bob/private");
  });

  it("denies root-owned repos unless they are explicitly visible", async () => {
    const ctx = makeContext(makeFetcher(() => {
      throw new Error("ripgit should not be called");
    }));

    await expect(handleRepoRead({
      repo: "root/gsv",
      path: "README.md",
    }, ctx)).rejects.toThrow("Forbidden: cannot read repo root/gsv");
  });

  it("allows reads from visible package source repos", async () => {
    const fetcher = makeFetcher((url) => {
      expect(url.pathname).toBe("/hyperspace/repos/root/gsv/read");
      expect(url.searchParams.get("path")).toBe("builtin-packages/wiki/src/package.ts");
      return new Response("export default {}\n", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    const ctx = makeContext(fetcher, {}, [
      {
        manifest: {
          source: {
            repo: "root/gsv",
          },
        },
      },
    ]);

    await expect(handleRepoRead({
      repo: "root/gsv",
      path: "builtin-packages/wiki/src/package.ts",
    }, ctx)).resolves.toMatchObject({
      repo: "root/gsv",
      kind: "file",
      content: "export default {}\n",
    });
  });

  it("allows reads from public repos owned by another user", async () => {
    const fetcher = makeFetcher((url) => {
      expect(url.pathname).toBe("/hyperspace/repos/bob/public/read");
      expect(url.searchParams.get("ref")).toBe("main");
      expect(url.searchParams.get("path")).toBe("README.md");
      return new Response("hello\n", {
        headers: { "Content-Type": "text/plain" },
      });
    });
    const ctx = makeContext(fetcher, {
      "config/pkg/public-repos/bob/public": "true",
    });

    await expect(handleRepoRead({
      repo: "bob/public",
      path: "README.md",
    }, ctx)).resolves.toMatchObject({
      repo: "bob/public",
      ref: "main",
      path: "README.md",
      kind: "file",
      content: "hello\n",
    });
  });

  it("compares refs through query parameters so branch names may contain slashes", async () => {
    const fetcher = makeFetcher((url) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/demo/compare");
      expect(url.searchParams.get("base")).toBe("refs/heads/main");
      expect(url.searchParams.get("head")).toBe("feature/docs");
      return Response.json({
        base_hash: "base123",
        head_hash: "head123",
        stats: { files_changed: 0, additions: 0, deletions: 0 },
        files: [],
      });
    });
    const ctx = makeContext(fetcher);

    await expect(handleRepoCompare({
      repo: "alice/demo",
      base: "refs/heads/main",
      head: "feature/docs",
    }, ctx)).resolves.toEqual({
      repo: "alice/demo",
      base: "base123",
      head: "head123",
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
      files: [],
    });
  });
});
