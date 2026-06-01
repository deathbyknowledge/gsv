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
      signal: "proc.run.finished",
      processId: "proc-child",
      key: "builder:product-alpha",
      state: { db: "product-alpha" },
    }, ctx);

    expect(result.watchId).toBe("watch-1");
    expect(ctx.signalWatches.upsert).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      signal: "proc.run.finished",
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

  it("scopes app-owned watches to the active app session client", () => {
    const ctx = makeContext({
      appFrame: {
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        uid: 1000,
        username: "hank",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
      },
      appSessions: {
        getActiveForUid: vi.fn(() => ({
          sessionId: "session-1",
          uid: 1000,
          username: "hank",
          packageId: "pkg-chat",
          packageName: "chat",
          entrypointName: "Chat",
          routeBase: "/apps/chat",
          createdAt: 1,
          lastUsedAt: null,
          expiresAt: Date.now() + 60_000,
          state: "active",
          clients: [{
            sessionId: "session-1",
            clientId: "client-1",
            uid: 1000,
            username: "hank",
            packageId: "pkg-chat",
            packageName: "chat",
            entrypointName: "Chat",
            routeBase: "/apps/chat",
            rpcBase: "/apps/sessions/session-1/clients/client-1/socket",
            createdAt: 1,
            lastUsedAt: null,
            expiresAt: Date.now() + 60_000,
          }],
        })),
      },
    });

    handleSignalWatch({
      signal: "proc.run.stream",
      processId: "proc-child",
      key: "chat:session-1:client-1:proc-child:proc.run.stream",
      owner: { appSessionId: "session-1", clientId: "client-1" },
      state: { clientId: "client-1", pid: "proc-child" },
      once: false,
    }, ctx);

    expect(ctx.appSessions.getActiveForUid).toHaveBeenCalledWith(1000, "session-1");
    expect(ctx.signalWatches.upsert).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: null,
      target: expect.objectContaining({
        kind: "app",
        appSessionId: "session-1",
        appClientId: "client-1",
      }),
    }));
  });

  it("requires process runtimes to watch an explicit other process", () => {
    const ctx = makeContext({
      processId: "proc-parent",
    });

    expect(() => handleSignalWatch({
      signal: "proc.run.finished",
    }, ctx)).toThrow("process runtimes must watch an explicit processId");

    expect(() => handleSignalWatch({
      signal: "proc.run.finished",
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
