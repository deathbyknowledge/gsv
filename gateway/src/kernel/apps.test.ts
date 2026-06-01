import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { InstalledPackageRecord } from "./packages";
import {
  AppSyscallError,
  handleAppAttach,
  handleAppClose,
  handleAppList,
  handleAppOpen,
} from "./apps";

function makePackageRecord(): InstalledPackageRecord {
  return {
    packageId: "pkg-chat",
    scope: { kind: "global" },
    manifest: {
      name: "chat",
      displayName: "Chat",
      description: "Chat app",
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo: "root/gsv",
        ref: "main",
        subdir: "builtin-packages/chat",
      },
      entrypoints: [{
        name: "Chat",
        kind: "ui",
        module: "src/app/main.tsx",
        route: "/apps/chat",
        windowDefaults: {
          width: 900,
          height: 700,
          minWidth: 640,
          minHeight: 480,
        },
      }],
      capabilities: {},
    },
    artifact: {
      hash: "sha256:test",
      mainModule: "src/app/main.tsx",
      modulePaths: ["src/app/main.tsx"],
    },
    grants: {},
    enabled: true,
    reviewRequired: false,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 2,
  };
}

function makeContext(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    identity: {
      role: "user",
      capabilities: ["app.*"],
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
      },
    },
    packages: {
      list: vi.fn(() => [makePackageRecord()]),
    },
    appSessions: {
      issue: vi.fn(async (input) => ({
        sessionId: "session-1",
        secret: "secret-1",
        clientId: input.clientId,
        uid: input.uid,
        username: input.username,
        packageId: input.packageId,
        packageName: input.packageName,
        entrypointName: input.entrypointName,
        routeBase: input.routeBase,
        rpcBase: "/apps/sessions/session-1/socket",
        createdAt: 1,
        expiresAt: 2,
        lastUsedAt: null,
      })),
      attach: vi.fn(async (input) => ({
        sessionId: "session-1",
        secret: "secret-2",
        clientId: input.clientId,
        uid: 1000,
        username: "alice",
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        rpcBase: "/apps/sessions/session-1/socket",
        createdAt: 1,
        expiresAt: 3,
        lastUsedAt: 2,
      })),
      list: vi.fn(() => [{
        sessionId: "session-1",
        uid: 1000,
        username: "alice",
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        rpcBase: "/apps/sessions/session-1/socket",
        createdAt: 1,
        expiresAt: 2,
        lastUsedAt: null,
        state: "active",
        clients: [{
          sessionId: "session-1",
          clientId: "win-1",
          uid: 1000,
          username: "alice",
          packageId: "pkg-chat",
          packageName: "chat",
          entrypointName: "Chat",
          routeBase: "/apps/chat",
          rpcBase: "/apps/sessions/session-1/socket",
          createdAt: 1,
          expiresAt: 2,
          lastUsedAt: null,
        }],
      }]),
      close: vi.fn(() => ({
        sessionId: "session-1",
        uid: 1000,
        username: "alice",
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        createdAt: 1,
        expiresAt: 2,
        lastUsedAt: null,
        state: "closed",
        clients: [],
      })),
    },
    ...overrides,
  } as unknown as KernelContext;
}

describe("app syscalls", () => {
  it("opens package apps through a launch URL", async () => {
    const ctx = makeContext();

    const result = await handleAppOpen({
      packageName: "chat",
      clientId: "win-1",
      suffix: "/threads/abc",
      search: "?view=compact",
      hash: "#bottom",
    }, ctx);

    expect(ctx.appSessions.issue).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      username: "alice",
      packageId: "pkg-chat",
      packageName: "chat",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      clientId: "win-1",
    }));
    expect(result.sessionId).toBe("session-1");
    expect(result.window).toMatchObject({ title: "Chat", width: 900 });

    const launch = new URL(result.launchUrl, "https://gsv.local");
    expect(launch.pathname).toBe("/apps/sessions/session-1/launch");
    expect(launch.searchParams.get("token")).toBe("secret-1");
    expect(launch.searchParams.get("next")).toBe("/threads/abc?view=compact#bottom");
  });

  it("attaches to an existing app session with a fresh launch secret", async () => {
    const ctx = makeContext();

    const result = await handleAppAttach({ sessionId: "session-1" }, ctx);

    expect(ctx.appSessions.attach).toHaveBeenCalledWith(expect.objectContaining({
      uid: 1000,
      sessionId: "session-1",
      ttlMs: expect.any(Number),
    }));
    expect(result.launchUrl).toContain("token=secret-2");
  });

  it("lists and closes sessions for the current user", async () => {
    const closeAppSession = vi.fn(async () => ({ closed: 1 }));
    const getAppRunner = vi.fn(() => ({ closeAppSession }));
    const ctx = makeContext({
      getAppRunner,
    });

    expect(handleAppList({}, ctx).sessions).toEqual([expect.objectContaining({
      sessionId: "session-1",
      packageName: "chat",
      state: "active",
      clients: [expect.objectContaining({ clientId: "win-1" })],
    })]);
    await expect(handleAppClose({ sessionId: "session-1" }, ctx)).resolves.toEqual({ closed: true });
    expect(ctx.appSessions.close).toHaveBeenCalledWith(1000, "session-1");
    expect(getAppRunner).toHaveBeenCalledWith(1000, "pkg-chat");
    expect(closeAppSession).toHaveBeenCalledWith("session-1");
  });

  it("returns a typed 404 when the package app is missing", async () => {
    const ctx = makeContext({
      packages: {
        list: vi.fn(() => []),
      } as unknown as KernelContext["packages"],
    });

    await expect(handleAppOpen({ packageName: "chat" }, ctx)).rejects.toMatchObject({
      status: 404,
      message: "Package app not found",
    } satisfies Partial<AppSyscallError>);
  });
});
