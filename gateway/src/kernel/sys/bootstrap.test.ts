type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import { BUILTIN_SKILL_FILES } from "./builtin-skills";
import { handleSysBootstrap } from "./bootstrap";
import { RipgitClient } from "../../fs/ripgit/client";

const importFromUpstreamMock = vi.spyOn(RipgitClient.prototype, "importFromUpstream");
const readPathMock = vi.spyOn(RipgitClient.prototype, "readPath");
const applyMock = vi.spyOn(RipgitClient.prototype, "apply");

function makeContext(): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const configValues = new Map<string, string>();
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    env: {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      RIPGIT: {} as Fetcher,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      STORAGE: {} as R2Bucket,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext["config"],
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

function setManualBootstrapEnv(ctx: KernelContext, upstream: string, ref?: string): void {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const env = ctx.env as Env & {
    GSV_MANUAL_BOOTSTRAP_UPSTREAM: string;
    GSV_MANUAL_BOOTSTRAP_REF?: string;
  };
  env.GSV_MANUAL_BOOTSTRAP_UPSTREAM = upstream;
  if (ref !== undefined) {
    env.GSV_MANUAL_BOOTSTRAP_REF = ref;
  }
}

describe("handleSysBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importFromUpstreamMock.mockImplementation((
      _repo: KernelTestValue,
      _actor: KernelTestValue,
      _email: KernelTestValue,
      _message: KernelTestValue,
      remoteUrl: string,
      ref: string,
    ) => Promise.resolve({
      remoteUrl,
      remoteRef: ref,
      head: "manual123",
      changed: true,
    }));
    readPathMock.mockResolvedValue({ kind: "missing" });
    applyMock.mockResolvedValue({ head: "home123" });
  });

  it("imports only root/gsv-manual and seeds the bundled skills", async () => {
    const ctx = makeContext();

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledTimes(1);
    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      { owner: "root", repo: "gsv-manual", branch: "main" },
      "root",
      "root@gsv.local",
      "bootstrap root/gsv-manual from https://github.com/deathbyknowledge/gsv-manual#main",
      "https://github.com/deathbyknowledge/gsv-manual",
      "main",
    );
    expect(BUILTIN_SKILL_FILES.map((skill) => skill.path)).toEqual([
      "browser-target/SKILL.md",
      "gsv-manual/SKILL.md",
      "image-reading/SKILL.md",
      "memory/SKILL.md",
      "process-orchestration/SKILL.md",
      "skill-authoring/SKILL.md",
    ]);
    expect(BUILTIN_SKILL_FILES.every((skill) => skill.content.startsWith("---\n"))).toBe(true);
    const expectedSkillOps = BUILTIN_SKILL_FILES.map((skill) => ({
      type: "put",
      path: `skills.d/${skill.path}`,
      contentBytes: Array.from(new TextEncoder().encode(skill.content)),
    }));
    expect(applyMock).toHaveBeenCalledWith(
      { owner: "root", repo: "home" },
      "root",
      "root@gsv.local",
      "gsv: seed built-in skills",
      [
        {
          type: "put",
          path: "skills.d/.dir",
          contentBytes: [],
        },
        ...expectedSkillOps,
      ],
    );
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/description", "GSV Manual");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/ref", "main");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/visibility", "public");
    expect(ctx.config.set).not.toHaveBeenCalledWith(
      expect.stringContaining("repos/root/gsv/"),
      expect.any(String),
    );
    expect(result).toEqual({
      repo: "root/gsv-manual",
      remoteUrl: "https://github.com/deathbyknowledge/gsv-manual",
      ref: "main",
      head: "manual123",
      changed: true,
    });
  });

  it("preserves an existing skill while adding the other bundled skills", async () => {
    readPathMock.mockImplementation((_repo: KernelTestValue, path: string) => Promise.resolve(
      path === "skills.d/browser-target/SKILL.md"
        ? { kind: "file", bytes: new Uint8Array([1]), size: 1 }
        : { kind: "missing" },
    ));

    await handleSysBootstrap(undefined, makeContext());

    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const operations = applyMock.mock.calls[0]?.[4] as Array<{ path: string }>;
    expect(operations.map((operation) => operation.path)).toEqual([
      "skills.d/.dir",
      "skills.d/gsv-manual/SKILL.md",
      "skills.d/image-reading/SKILL.md",
      "skills.d/memory/SKILL.md",
      "skills.d/process-orchestration/SKILL.md",
      "skills.d/skill-authoring/SKILL.md",
    ]);
  });

  it("uses the independently configured manual upstream and ref", async () => {
    const ctx = makeContext();
    setManualBootstrapEnv(ctx, "example/private-manual#preview", "release");

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "bootstrap root/gsv-manual from https://github.com/example/private-manual#release",
      "https://github.com/example/private-manual",
      "release",
    );
    expect(result.remoteUrl).toBe("https://github.com/example/private-manual");
    expect(result.ref).toBe("release");
  });

  it("does not seed skills when the manual import fails", async () => {
    importFromUpstreamMock.mockRejectedValue(new Error("manual unavailable"));

    await expect(handleSysBootstrap(undefined, makeContext())).rejects.toThrow(
      "manual unavailable",
    );
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("rejects obsolete source overrides", async () => {
    await expect(handleSysBootstrap(
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      { repo: "example/old-system-source" } as never,
      makeContext(),
    )).rejects.toThrow("sys.bootstrap does not accept source overrides");
    expect(importFromUpstreamMock).not.toHaveBeenCalled();
  });

  it("requires the RIPGIT binding", async () => {
    const ctx = makeContext();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    delete (ctx.env as Partial<Env>).RIPGIT;

    await expect(handleSysBootstrap(undefined, ctx)).rejects.toThrow(
      "RIPGIT binding is required for system bootstrap",
    );
  });
});
