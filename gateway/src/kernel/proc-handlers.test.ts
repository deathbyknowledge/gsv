import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { ProcIpcSendResult } from "../syscalls/proc";
import type { KernelContext } from "./context";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { forwardToProcess, handleProcIpcCall, handleProcSpawn } from "./proc-handlers";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("proc handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("cleans up pending IPC call when delivery returns an error response", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "deliver",
      ok: false,
      error: { code: 500, message: "target rejected delivery" },
    } satisfies ResponseFrame);

    const { ctx, ipcCalls } = makeIpcCallContext();
    const result = await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "target rejected delivery" });
    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    expect(callId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.attachRun).not.toHaveBeenCalled();
    expect(ctx.scheduleIpcCallTimeout).not.toHaveBeenCalled();
  });

  it("derives client interaction origin for forwarded proc.send", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "send-1",
      ok: true,
      data: { ok: true, status: "started", runId: "run-1" },
    } satisfies ResponseFrame);

    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["proc.send"],
      },
      connection: {
        id: "conn-1",
        state: {
          clientId: "browser-shell",
          clientPlatform: "web",
        },
      },
      procs: {
        get: vi.fn(() => ({ uid: IDENTITY.uid, ownerUid: IDENTITY.uid })),
      },
    } as unknown as KernelContext;
    const spoofedOrigin = {
      kind: "adapter",
      adapter: "whatsapp",
      accountId: "primary",
      surface: { kind: "dm", id: "dm-1" },
      actorId: "external",
    };

    await forwardToProcess({
      type: "req",
      id: "send-1",
      call: "proc.send",
      args: {
        message: "hello",
        origin: spoofedOrigin,
      },
    } as RequestFrame, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "init:1000",
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({
          message: "hello",
          origin: {
            kind: "client",
            connectionId: "conn-1",
            clientId: "browser-shell",
            platform: "web",
          },
        }),
      }),
    );
  });

  it("cleans up pending IPC call when delivery reports failure", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "deliver",
      ok: true,
      data: { ok: false, error: "target unavailable" } satisfies ProcIpcSendResult,
    } satisfies ResponseFrame);

    const { ctx, ipcCalls } = makeIpcCallContext();
    const result = await handleProcIpcCall({
      pid: "target-process",
      message: "bounded work",
    }, ctx);

    expect(result).toEqual({ ok: false, error: "target unavailable" });
    const callId = ipcCalls.create.mock.calls[0]?.[0]?.callId;
    expect(callId).toBeTruthy();
    expect(ipcCalls.remove).toHaveBeenCalledWith(callId);
    expect(ipcCalls.attachRun).not.toHaveBeenCalled();
    expect(ctx.scheduleIpcCallTimeout).not.toHaveBeenCalled();
  });

  it("uses disambiguated package source mount paths", async () => {
    const pkgA = makePackage("pkg-a", "Demo Tool", "sam/demo-a");
    const pkgB = makePackage("pkg-b", "demo-tool", "sam/demo-b");
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn((packageId: string) => {
          if (packageId === "pkg-a") return pkgA;
          if (packageId === "pkg-b") return pkgB;
          return null;
        }),
        list: vi.fn(() => [pkgA, pkgB]),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      parentPid: `init:${IDENTITY.uid}`,
      mounts: [
        { kind: "package-source", packageId: "pkg-a" },
        { kind: "package-source", packageId: "pkg-b" },
      ],
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/packages/demo-tool--sam-demo-a",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/src/packages/demo-tool--sam-demo-a" }),
      expect.objectContaining({
        mounts: [
          expect.objectContaining({
            packageId: "pkg-a",
            mountPath: "/src/packages/demo-tool--sam-demo-a",
          }),
          expect.objectContaining({
            packageId: "pkg-b",
            mountPath: "/src/packages/demo-tool--sam-demo-b",
          }),
        ],
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      call: "proc.setidentity",
    }));
  });

  it("materializes visible package source mounts by default without changing cwd", async () => {
    const pkgA = makePackage("pkg-a", "Demo Tool", "sam/demo-a");
    const pkgB = makePackage("pkg-b", "Other Tool", "sam/other-b");
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn((packageId: string) => {
          if (packageId === "pkg-a") return pkgA;
          if (packageId === "pkg-b") return pkgB;
          return null;
        }),
        list: vi.fn(() => [pkgA, pkgB]),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({ parentPid: `init:${IDENTITY.uid}` }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/home/sam",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/home/sam" }),
      expect.objectContaining({
        mounts: [
          expect.objectContaining({
            packageId: "pkg-a",
            scope: pkgA.scope,
            mountPath: "/src/packages/demo-tool",
          }),
          expect.objectContaining({
            packageId: "pkg-b",
            scope: pkgB.scope,
            mountPath: "/src/packages/other-tool",
          }),
        ],
      }),
    );
  });

  it("spawns a fresh interactive worker for a parented spawn", async () => {
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn(() => null),
        list: vi.fn(() => []),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({ parentPid: `init:${IDENTITY.uid}` }, ctx);

    expect(result).toMatchObject({ ok: true });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ interactive: true }),
    );
  });

  it("uses distinct default mount paths for package source and repo mounts", async () => {
    const pkg = makePackage("pkg-a", "Demo Tool", "sam/demo-a", "packages/demo-tool");
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn((packageId: string) => packageId === "pkg-a" ? pkg : null),
        list: vi.fn(() => [pkg]),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      parentPid: `init:${IDENTITY.uid}`,
      mounts: [
        { kind: "package-source", packageId: "pkg-a" },
        { kind: "package-repo", packageId: "pkg-a" },
      ],
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/packages/demo-tool",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/src/packages/demo-tool" }),
      expect.objectContaining({
        mounts: [
          expect.objectContaining({
            mountPath: "/src/packages/demo-tool",
            subdir: "packages/demo-tool",
          }),
          expect.objectContaining({
            mountPath: "/src/repos/sam-demo-a",
            subdir: ".",
          }),
        ],
      }),
    );
  });

  it("prefers package source mounts for default spawn cwd", async () => {
    const pkg = makePackage("pkg-a", "Demo Tool", "sam/demo-a", "packages/demo-tool");
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn((packageId: string) => packageId === "pkg-a" ? pkg : null),
        list: vi.fn(() => [pkg]),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      parentPid: `init:${IDENTITY.uid}`,
      mounts: [
        { kind: "package-repo", packageId: "pkg-a" },
        { kind: "package-source", packageId: "pkg-a" },
      ],
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/packages/demo-tool",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/src/packages/demo-tool" }),
      expect.objectContaining({
        mounts: [
          expect.objectContaining({
            mountPath: "/src/repos/sam-demo-a",
            subdir: ".",
          }),
          expect.objectContaining({
            mountPath: "/src/packages/demo-tool",
            subdir: "packages/demo-tool",
          }),
        ],
      }),
    );
  });

  it("preserves caller-supplied package source mount paths", async () => {
    const pkg = makePackage("pkg-a", "Demo Tool", "sam/demo-a", "packages/demo-tool");
    const ctx = {
      env: {},
      identity: {
        process: IDENTITY,
        capabilities: ["*"],
      },
      procs: {
        get: vi.fn(() => null),
        spawn: vi.fn(),
      },
      packages: {
        resolve: vi.fn((packageId: string) => packageId === "pkg-a" ? pkg : null),
        list: vi.fn(() => [pkg]),
      },
    } as unknown as KernelContext;

    const result = await handleProcSpawn({
      parentPid: `init:${IDENTITY.uid}`,
      mounts: [
        { kind: "package-source", packageId: "pkg-a", mountPath: "/src/custom/demo" },
      ],
    }, ctx);

    expect(result).toMatchObject({
      ok: true,
      cwd: "/src/custom/demo",
    });
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/src/custom/demo" }),
      expect.objectContaining({
        mounts: [
          expect.objectContaining({
            mountPath: "/src/custom/demo",
            subdir: "packages/demo-tool",
          }),
        ],
      }),
    );
  });
});

function makeIpcCallContext() {
  const ipcCalls = {
    create: vi.fn(),
    remove: vi.fn(),
    attachRun: vi.fn(),
  };
  const ctx = {
    processId: "source-process",
    identity: { process: IDENTITY },
    procs: {
      get: vi.fn((pid: string) => {
        if (pid === "source-process") return { uid: IDENTITY.uid };
        if (pid === "target-process") return { uid: IDENTITY.uid };
        return undefined;
      }),
    },
    ipcCalls,
    scheduleIpcCallTimeout: vi.fn(async () => "timeout-schedule"),
  } as unknown as KernelContext;

  return { ctx, ipcCalls };
}

function makePackage(packageId: string, name: string, repo: string, subdir = ".") {
  return {
    packageId,
    scope: { kind: "user", uid: IDENTITY.uid },
    manifest: {
      name,
      description: name,
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo,
        ref: "main",
        subdir,
        resolvedCommit: "base123",
      },
      entrypoints: [],
    },
    artifact: { hash: "hash", mainModule: "main.js", modulePaths: ["main.js"] },
    enabled: true,
    reviewRequired: false,
    reviewedAt: 1,
    installedAt: 1,
    updatedAt: 1,
  };
}
