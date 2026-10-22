type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { handleSysBootstrap } from "./bootstrap";
import { ManualUpdater, type ManualUpdateState } from "./manual";
import manualVersion from "./manual-version.json";
import { RipgitClient } from "../../fs/ripgit/client";

const importFromUpstreamMock = vi.spyOn(RipgitClient.prototype, "importFromUpstream");
const readPathMock = vi.spyOn(RipgitClient.prototype, "readPath");
const applyMock = vi.spyOn(RipgitClient.prototype, "apply");

function makeContext(): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const configValues = new Map<string, string>();
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  const ctx = {
    env: {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      RIPGIT: {} as Fetcher,
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      STORAGE: {} as R2Bucket,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as Env,
    peer: testPeer({ kind: "human", account: {
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      }, calls: ["*"] }),
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
  const values = new Map<string, ManualUpdateState>();
  // SAFETY: the updater only uses get/put for its opaque ManualUpdateState record.
  ctx.manual = new ManualUpdater({ kv: {
    get: (key: string) => values.get(key),
    put: (key: string, value: ManualUpdateState) => { values.set(key, value); },
  } as DurableObjectStorage["kv"] }, ctx, async () => true);
  return ctx;
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

  it("imports only root/gsv-manual and writes no skills into the home", async () => {
    const ctx = makeContext();

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledTimes(1);
    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      { owner: "root", repo: "gsv-manual", branch: "main" },
      "root",
      "root@gsv.local",
      "gsv: update manual",
      "https://github.com/deathbyknowledge/gsv-manual",
      manualVersion.revision,
    );
    expect(applyMock).not.toHaveBeenCalled();
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/description", "Ship Manual");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/ref", "main");
    expect(ctx.config.set).toHaveBeenCalledWith("repos/root/gsv-manual/visibility", "public");
    expect(ctx.config.set).not.toHaveBeenCalledWith(
      expect.stringContaining("repos/root/gsv/"),
      expect.any(String),
    );
    expect(result).toEqual({
      repo: "root/gsv-manual",
      remoteUrl: "https://github.com/deathbyknowledge/gsv-manual",
      ref: manualVersion.revision,
      head: "manual123",
      changed: true,
    });
  });

  it("uses the independently configured manual upstream and ref", async () => {
    const ctx = makeContext();
    setManualBootstrapEnv(ctx, "example/private-manual#preview", "release");

    const result = await handleSysBootstrap(undefined, ctx);

    expect(importFromUpstreamMock).toHaveBeenCalledWith(
      expect.any(Object),
      "root",
      "root@gsv.local",
      "gsv: update manual",
      "https://github.com/example/private-manual",
      "release",
    );
    expect(result.remoteUrl).toBe("https://github.com/example/private-manual");
    expect(result.ref).toBe("release");
  });

  it("writes nothing when the manual import fails", async () => {
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
