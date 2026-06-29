import { describe, expect, it } from "vitest";
import type { KernelContext } from "./context";
import {
  canReadRepo,
  canWriteRepo,
  handleRepoApply,
  handleRepoCompare,
  handleRepoCreate,
  handleRepoDelete,
  handleRepoImport,
  handleRepoList,
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
  packages: Array<{
    packageId?: string;
    manifest: {
      name?: string;
      source: {
        repo: string;
        ref?: string;
        subdir?: string;
        resolvedCommit?: string | null;
      };
    };
    updatedAt?: number;
  }> = [],
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
      },
    },
    auth: {
      getPasswdByUid: (uid: number) => {
        if (uid === 1000) return { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" };
        if (uid === 2000) return { uid: 2000, gid: 2000, username: "scout", home: "/home/scout" };
        return null;
      },
      getPasswdByUsername: (username: string) => {
        if (username === "alice") return { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" };
        if (username === "scout") return { uid: 2000, gid: 2000, username: "scout", home: "/home/scout" };
        return null;
      },
      getPersonalAgentUid: () => null,
      getGroupByGid: (gid: number) => {
        if (gid === 2000) return { name: "scout", gid: 2000, members: ["alice"] };
        if (gid === 1000) return { name: "alice", gid: 1000, members: [] };
        return null;
      },
      getGroupByName: () => null,
    },
    packages: {
      list: () => packages,
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

  it("imports an explicit upstream and records repo metadata", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/demo/import");
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        head: "imported123",
        changed: true,
        remote_url: "https://github.com/example/demo",
        remote_ref: "main",
      });
    });
    const ctx = makeContext(fetcher);

    const result = await handleRepoImport({
      repo: "alice/demo",
      remoteUrl: "https://github.com/example/demo",
    }, ctx);

    expect(result).toEqual({
      repo: "alice/demo",
      ref: "main",
      head: "imported123",
      changed: true,
      remoteUrl: "https://github.com/example/demo",
      remoteRef: "main",
    });
    const body = JSON.parse(String(fetcher.calls[0].init?.body));
    expect(body).toMatchObject({
      defaultBranch: "main",
      message: "repo: import https://github.com/example/demo#main",
      remoteUrl: "https://github.com/example/demo",
      remoteRef: "main",
    });
    expect(ctx.config.get("repos/alice/demo/created_at")).not.toBeNull();
  });

  it("deletes a writable repository and unregisters repo metadata", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/alice/demo");
      expect(init?.method).toBe("DELETE");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Ripgit-Actor-Name")).toBe("alice");
      return new Response("deleted");
    });
    const ctx = makeContext(fetcher, {
      "repos/alice/demo/created_at": "1",
      "repos/alice/demo/updated_at": "2",
      "repos/alice/demo/description": "Demo",
      "repos/alice/demo/visibility": "public",
    });

    const result = await handleRepoDelete({ repo: "alice/demo" }, ctx);

    expect(result).toEqual({
      deleted: true,
      repo: "alice/demo",
    });
    expect(ctx.config.get("repos/alice/demo/created_at")).toBeNull();
    expect(ctx.config.get("repos/alice/demo/updated_at")).toBeNull();
    expect(ctx.config.get("repos/alice/demo/description")).toBeNull();
    expect(ctx.config.get("repos/alice/demo/visibility")).toBeNull();
  });

  it("refuses to delete repositories backing installed packages", async () => {
    const fetcher = makeFetcher(() => {
      throw new Error("ripgit should not be called");
    });
    const ctx = makeContext(fetcher, {}, [{
      packageId: "pkg-demo",
      manifest: {
        name: "Demo Package",
        source: {
          repo: "alice/demo",
        },
      },
    }]);

    await expect(handleRepoDelete({ repo: "alice/demo" }, ctx)).rejects.toThrow(
      "Repository alice/demo backs installed packages: Demo Package",
    );
    expect(fetcher.calls).toHaveLength(0);
  });

  it("pulls from the configured upstream when no remote url is supplied", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/demo/import");
      expect(init?.method).toBe("POST");
      return Response.json({
        ok: true,
        head: "pulled123",
        changed: true,
        remote_url: "https://github.com/example/demo",
        remote_ref: "main",
      });
    });
    const ctx = makeContext(fetcher);

    const result = await handleRepoImport({
      repo: "alice/demo",
      ref: "main",
    }, ctx);

    expect(result).toMatchObject({
      repo: "alice/demo",
      ref: "main",
      head: "pulled123",
      remoteUrl: "https://github.com/example/demo",
      remoteRef: "main",
    });
    const body = JSON.parse(String(fetcher.calls[0].init?.body));
    expect(body).toMatchObject({
      defaultBranch: "main",
      message: "repo: pull upstream for alice/demo#main",
    });
    expect(body.remoteUrl).toBeUndefined();
    expect(body.remoteRef).toBeUndefined();
  });

  it("surfaces upstream tracking details from ripgit imports", async () => {
    const fetcher = makeFetcher((url) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/demo/import");
      return Response.json({
        ok: true,
        head: "local123",
        changed: false,
        remote_url: "https://github.com/example/demo",
        remote_ref: "main",
        tracking_ref: "refs/remotes/upstream/main",
        upstream_head: "upstream456",
        upstream_changed: true,
        local_changed: false,
        diverged: true,
      });
    });
    const ctx = makeContext(fetcher);

    const result = await handleRepoImport({
      repo: "alice/demo",
      ref: "main",
    }, ctx);

    expect(result).toMatchObject({
      repo: "alice/demo",
      ref: "main",
      head: "local123",
      changed: false,
      remoteUrl: "https://github.com/example/demo",
      remoteRef: "main",
      trackingRef: "refs/remotes/upstream/main",
      upstreamHead: "upstream456",
      upstreamChanged: true,
      localChanged: false,
      diverged: true,
    });
  });

  it("denies private repos owned by another user", async () => {
    const ctx = makeContext(makeFetcher(() => {
      throw new Error("ripgit should not be called");
    }));

    expect(canReadRepo("bob/private", ctx)).toBe(false);

    await expect(handleRepoRead({
      repo: "bob/private",
      path: "README.md",
    }, ctx)).rejects.toThrow("Forbidden: cannot read repo bob/private");
  });

  it("lets the owning human list and write repos owned by their agent", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/hyperspace/repos/scout/memory/apply");
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, head: "agent123", conflict: false });
    });
    const ctx = makeContext(fetcher, {
      "repos/scout/memory/created_at": "100",
      "repos/scout/memory/description": "Agent memory",
    });

    expect(handleRepoList({}, ctx).repos).toContainEqual({
      repo: "scout/memory",
      owner: "scout",
      name: "memory",
      kind: "user",
      writable: true,
      public: false,
      description: "Agent memory",
      updatedAt: 100,
    });

    await expect(handleRepoApply({
      repo: "scout/memory",
      message: "memory: update",
      ops: [{ type: "put", path: "index.md", content: "# Memory\n" }],
    }, ctx)).resolves.toMatchObject({
      ok: true,
      repo: "scout/memory",
      head: "agent123",
    });
  });

  it("lets an owner-backed agent process write the owning human's repos", async () => {
    const fetcher = makeFetcher((url, init) => {
      expect(url.pathname).toBe("/hyperspace/repos/alice/private/apply");
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, head: "owner123", conflict: false });
    });
    const ctx = makeContext(fetcher);
    ctx.identity = {
      role: "user",
      capabilities: ["repo.apply"],
      process: {
        uid: 2000,
        gid: 2000,
        gids: [2000, 1000],
        username: "scout",
        home: "/home/scout",
        cwd: "/home/scout",
      },
    };
    ctx.processId = "proc:scout";
    ctx.procs = {
      getOwnerUid: () => 1000,
    } as KernelContext["procs"];

    await expect(handleRepoApply({
      repo: "alice/private",
      message: "owner: update",
      ops: [{ type: "put", path: "notes.md", content: "secret\n" }],
    }, ctx)).resolves.toMatchObject({
      ok: true,
      repo: "alice/private",
      head: "owner123",
    });
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
      expect(url.searchParams.get("path")).toBe("packages/wiki/src/package.ts");
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

    expect(canReadRepo("root/gsv", ctx)).toBe(true);

    await expect(handleRepoRead({
      repo: "root/gsv",
      path: "packages/wiki/src/package.ts",
    }, ctx)).resolves.toMatchObject({
      repo: "root/gsv",
      kind: "file",
      content: "export default {}\n",
    });
  });

  it("lists visible package source repos at their installed source ref", () => {
    const ctx = makeContext(makeFetcher(() => {
      throw new Error("ripgit should not be called");
    }), {}, [
      {
        manifest: {
          name: "Wiki",
          source: {
            repo: "root/gsv",
            ref: "feature/wiki",
            subdir: "packages/wiki",
            resolvedCommit: "commit123",
          },
        },
        updatedAt: 200,
      },
    ]);

    expect(handleRepoList({}, ctx).repos).toContainEqual({
      repo: "root/gsv",
      owner: "root",
      name: "gsv",
      kind: "package",
      writable: false,
      public: false,
      ref: "feature/wiki",
      baseRef: "commit123",
      sources: [{
        kind: "package",
        packageId: undefined,
        name: "Wiki",
        subdir: "packages/wiki",
        ref: "feature/wiki",
        baseRef: "commit123",
        updatedAt: 200,
      }],
      description: "Wiki",
      updatedAt: 200,
    });
  });

  it("keeps same-repo package source refs separate when listing repos", () => {
    const ctx = makeContext(makeFetcher(() => {
      throw new Error("ripgit should not be called");
    }), {}, [
      {
        packageId: "pkg-a",
        manifest: {
          name: "Package A",
          source: {
            repo: "root/gsv",
            ref: "feature/a",
            subdir: "packages/a",
            resolvedCommit: "commit-a",
          },
        },
        updatedAt: 100,
      },
      {
        packageId: "pkg-b",
        manifest: {
          name: "Package B",
          source: {
            repo: "root/gsv",
            ref: "feature/b",
            subdir: "packages/b",
            resolvedCommit: "commit-b",
          },
        },
        updatedAt: 200,
      },
    ]);

    expect(handleRepoList({}, ctx).repos).toContainEqual(expect.objectContaining({
      repo: "root/gsv",
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
          updatedAt: 100,
        },
        {
          kind: "package",
          packageId: "pkg-b",
          name: "Package B",
          subdir: "packages/b",
          ref: "feature/b",
          baseRef: "commit-b",
          updatedAt: 200,
        },
      ],
    }));
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
      "repos/bob/public/visibility": "public",
    });

    expect(canReadRepo("bob/public", ctx)).toBe(true);
    expect(canWriteRepo("bob/public", ctx)).toBe(false);

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
