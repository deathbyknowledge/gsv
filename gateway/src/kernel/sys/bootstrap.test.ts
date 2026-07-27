import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import { handleSysBootstrap } from "./bootstrap";

const { importFromUpstreamMock, readPathMock, applyMock } = vi.hoisted(() => ({
  importFromUpstreamMock: vi.fn(),
  readPathMock: vi.fn(),
  applyMock: vi.fn(),
}));

vi.mock("../../fs/ripgit/client", () => ({
  RipgitClient: class {
    importFromUpstream = importFromUpstreamMock;
    readPath = readPathMock;
    apply = applyMock;
  },
}));

function makeContext(): KernelContext {
  const configValues = new Map<string, string>();
  return {
    env: {
      RIPGIT: {} as Fetcher,
      STORAGE: {} as R2Bucket,
    } as Env,
    identity: {
      role: "user",
      process: {
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      },
      capabilities: ["*"],
    },
    config: {
      get: vi.fn((key: string) => configValues.get(key) ?? null),
      set: vi.fn((key: string, value: string) => {
        configValues.set(key, value);
      }),
      list: vi.fn((prefix: string) =>
        [...configValues.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value }))
      ),
    } as unknown as KernelContext["config"],
  } as KernelContext;
}

function setBootstrapEnv(ctx: KernelContext, upstream: string, ref?: string): void {
  const env = ctx.env as Env & {
    GSV_BOOTSTRAP_UPSTREAM: string;
    GSV_BOOTSTRAP_REF?: string;
  };
  env.GSV_BOOTSTRAP_UPSTREAM = upstream;
  if (ref !== undefined) {
    env.GSV_BOOTSTRAP_REF = ref;
  }
}

describe("handleSysBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importFromUpstreamMock.mockImplementation((
      _repo: unknown,
      _actor: unknown,
      _email: unknown,
      _message: unknown,
      remoteUrl: string,
      ref: string,
    ) => Promise.resolve({
      remoteUrl,
      remoteRef: ref,
      head: "abc123",
      changed: true,
    }));
    readPathMock.mockImplementation((repo: { owner: string; repo: string }, path: string) => {
      if (repo.owner === "root" && repo.repo === "gsv" && path === "skills") {
        return {
          kind: "tree",
          entries: [{ name: "gsv-package-development", type: "tree", mode: "040000", hash: "a" }],
        };
      }
      if (repo.owner === "root" && repo.repo === "gsv" && path === "skills/gsv-package-development") {
        return {
          kind: "tree",
          entries: [{ name: "SKILL.md", type: "blob", mode: "100644", hash: "b" }],
        };
      }
      if (repo.owner === "root" && repo.repo === "gsv" && path === "skills/gsv-package-development/SKILL.md") {
        return {
          kind: "file",
          bytes: new TextEncoder().encode("---\nname: gsv-package-development\ndescription: Package work.\n---\n\n# Package Work\n"),
          size: 80,
        };
      }
      return { kind: "missing" };
    });
    applyMock.mockResolvedValue({ head: "home123" });
  });

  it("bootstraps root/gsv from the default upstream without seeding builtin packages", async () => {
    const ctx = makeContext();

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      { owner: "root", repo: "gsv", branch: "main" },
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/deathbyknowledge/gsv#main",
      "https://github.com/deathbyknowledge/gsv",
      "main",
    );
    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      { owner: "root", repo: "gsv-manual", branch: "main" },
      "root",
      "root@gsv.local",
      "bootstrap root/gsv-manual from https://github.com/deathbyknowledge/gsv-manual#main",
      "https://github.com/deathbyknowledge/gsv-manual",
      "main",
    );
    expect(applyMock).toHaveBeenCalledWith(
      { owner: "root", repo: "home" },
      "root",
      "root@gsv.local",
      "gsv: seed bootstrap skills",
      [
        {
          type: "put",
          path: "skills.d/.dir",
          contentBytes: [],
        },
        {
          type: "put",
          path: "skills.d/gsv-package-development/SKILL.md",
          contentBytes: Array.from(new TextEncoder().encode("---\nname: gsv-package-development\ndescription: Package work.\n---\n\n# Package Work\n")),
        },
      ],
    );
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv/created_at", expect.any(String));
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv/description", "GSV System Source");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv/visibility", "public");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/description", "GSV Manual");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/visibility", "public");
    expect(result).toEqual({
      repo: "root/gsv",
      remoteUrl: "https://github.com/deathbyknowledge/gsv",
      ref: "main",
      head: "abc123",
      changed: true,
      manual: {
        repo: "root/gsv-manual",
        remoteUrl: "https://github.com/deathbyknowledge/gsv-manual",
        ref: "main",
        head: "abc123",
        changed: true,
      },
    });
  });

  it("pins the default root/gsv source to a stable gateway release", async () => {
    vi.resetModules();
    vi.doMock("../../version", () => ({ SERVER_RELEASE: "v0.4.0" }));

    try {
      const { handleSysBootstrap: handleStableBootstrap } = await import("./bootstrap");

      await handleStableBootstrap(undefined, makeContext());

      expect(importFromUpstreamMock).toHaveBeenCalledWith(
        { owner: "root", repo: "gsv", branch: "main" },
        "root",
        "root@gsv.local",
        "bootstrap root/gsv from https://github.com/deathbyknowledge/gsv#refs/tags/v0.4.0",
        "https://github.com/deathbyknowledge/gsv",
        "refs/tags/v0.4.0",
      );
      expect(importFromUpstreamMock).toHaveBeenCalledWith(
        { owner: "root", repo: "gsv-manual", branch: "main" },
        "root",
        "root@gsv.local",
        "bootstrap root/gsv-manual from https://github.com/deathbyknowledge/gsv-manual#main",
        "https://github.com/deathbyknowledge/gsv-manual",
        "main",
      );
    } finally {
      vi.doUnmock("../../version");
      vi.resetModules();
    }
  });

  it("accepts repo shorthand and custom ref", async () => {
    const ctx = makeContext();

    await handleSysBootstrap({ repo: "example/custom-gsv", ref: "feature/main" }, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/example/custom-gsv#feature/main",
      "https://github.com/example/custom-gsv",
      "feature/main",
    );
  });

  it("does not seed user files when the manual import fails", async () => {
    importFromUpstreamMock.mockImplementation((repo: { repo: string }) => {
      if (repo.repo === "gsv-manual") {
        return Promise.reject(new Error("manual unavailable"));
      }
      return Promise.resolve({
        remoteUrl: "https://github.com/deathbyknowledge/gsv",
        remoteRef: "main",
        head: "abc123",
        changed: true,
      });
    });

    await expect(handleSysBootstrap(undefined, makeContext())).rejects.toThrow(
      "manual unavailable",
    );
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("uses the configured upstream env when args are omitted", async () => {
    const ctx = makeContext();
    setBootstrapEnv(ctx, "example/dev-gsv#feature/bootstrap");

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/example/dev-gsv#feature/bootstrap",
      "https://github.com/example/dev-gsv",
      "feature/bootstrap",
    );
    expect(result.remoteUrl).toBe("https://github.com/example/dev-gsv");
    expect(result.ref).toBe("feature/bootstrap");
  });

  it("lets configured ref env override an upstream env fragment", async () => {
    const ctx = makeContext();
    setBootstrapEnv(ctx, "https://git.example.com/team/gsv.git#feature/bootstrap", "release");

    await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://git.example.com/team/gsv.git#release",
      "https://git.example.com/team/gsv.git",
      "release",
    );
  });

  it("lets explicit bootstrap args override configured upstream env", async () => {
    const ctx = makeContext();
    setBootstrapEnv(ctx, "example/dev-gsv", "feature/bootstrap");

    await handleSysBootstrap({ repo: "example/custom-gsv", ref: "release" }, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://github.com/example/custom-gsv#release",
      "https://github.com/example/custom-gsv",
      "release",
    );
  });

  it("prefers explicit remoteUrl over repo shorthand", async () => {
    const ctx = makeContext();

    await handleSysBootstrap(
      {
        remoteUrl: "https://git.example.com/team/gsv.git",
        repo: "ignored/example",
        ref: "stable",
      },
      ctx,
    );

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv from https://git.example.com/team/gsv.git#stable",
      "https://git.example.com/team/gsv.git",
      "stable",
    );
  });

  it("rejects invalid repo shorthand", async () => {
    const ctx = makeContext();

    await expect(handleSysBootstrap({ repo: "not valid" }, ctx)).rejects.toThrow(
      "Invalid bootstrap repo: not valid",
    );
  });

  it("requires the RIPGIT binding", async () => {
    const ctx = makeContext();
    delete (ctx.env as Partial<Env>).RIPGIT;

    await expect(handleSysBootstrap(undefined, ctx)).rejects.toThrow(
      "RIPGIT binding is required for system bootstrap",
    );
  });
});
