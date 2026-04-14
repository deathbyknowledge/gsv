import { describe, expect, it, vi } from "vitest";
import { handleSignalUnwatch, handleSignalWatch } from "./signals";
import type { KernelContext } from "./context";

function makeContext(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "hank",
        home: "/home/hank",
        cwd: "/home/hank",
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    signalWatches: {
      upsert: vi.fn(() => ({
        created: true,
        watch: {
          watchId: "watch-1",
          createdAt: 1,
          expiresAt: 2,
        },
      })),
      removeById: vi.fn(() => 1),
      removeByKey: vi.fn(() => 1),
    },
    procs: {
      get: vi.fn(() => ({ uid: 1000 })),
    },
    ...overrides,
  } as unknown as KernelContext;
}

describe("signal watch handlers", () => {
  it("registers app-owned watches against the current app frame", () => {
    const ctx = makeContext({
      appFrame: {
        packageId: "pkg-wiki",
        packageName: "wiki",
        entrypointName: "wiki",
        routeBase: "/apps/wiki",
        uid: 1000,
        username: "hank",
        capabilities: ["*"],
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = handleSignalWatch({
      signal: "chat.complete",
      processId: "proc-child",
      key: "builder:product-alpha",
      state: { db: "product-alpha" },
    }, ctx);

    expect(result.watchId).toBe("watch-1");
    expect(ctx.signalWatches.upsert).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      signal: "chat.complete",
      processId: "proc-child",
      key: "builder:product-alpha",
      state: { db: "product-alpha" },
      target: expect.objectContaining({
        kind: "app",
        packageId: "pkg-wiki",
        packageName: "wiki",
        entrypointName: "wiki",
        routeBase: "/apps/wiki",
      }),
    }));
  });

  it("requires process runtimes to watch an explicit other process", () => {
    const ctx = makeContext({
      processId: "proc-parent",
    });

    expect(() => handleSignalWatch({
      signal: "chat.complete",
    }, ctx)).toThrow("process runtimes must watch an explicit processId");

    expect(() => handleSignalWatch({
      signal: "chat.complete",
      processId: "proc-parent",
    }, ctx)).toThrow("process runtimes cannot watch their own signals");
  });

  it("unwatch delegates by key for the current target", () => {
    const ctx = makeContext({
      processId: "proc-parent",
    });

    const result = handleSignalUnwatch({ key: "builder:product-alpha" }, ctx);

    expect(result.removed).toBe(1);
    expect(ctx.signalWatches.removeByKey).toHaveBeenCalledWith(
      1000,
      { kind: "process", processId: "proc-parent" },
      "builder:product-alpha",
    );
  });
});
