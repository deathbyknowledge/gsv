import { describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { Kernel } from "./do";
import type { UserKernelInstanceMarker } from "./user-kernels";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "alice",
  home: "/home/alice",
  cwd: "/home/alice",
};

function activeMarker(generation = 4): UserKernelInstanceMarker {
  return {
    version: 1,
    kind: "user",
    username: "alice",
    uid: IDENTITY.uid,
    generation,
    lifecycle: "active",
    updatedAt: 1,
  };
}

function processRecord(kernelGeneration: number | null) {
  return {
    processId: "proc:alice",
    parentPid: null,
    kernelGeneration,
    uid: IDENTITY.uid,
    ownerUid: IDENTITY.uid,
    interactive: true,
    gid: IDENTITY.gid,
    gids: IDENTITY.gids,
    username: IDENTITY.username,
    home: IDENTITY.home,
    cwd: IDENTITY.cwd,
    state: "idle",
    activeRunId: null,
    activeConversationId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: null,
    createdAt: 1,
    contextFiles: [],
    packageSecurityRevision: null,
  };
}

function userKernel(processGeneration: number | null) {
  const kernel = Object.create(Kernel.prototype) as any;
  Object.defineProperty(kernel, "name", { value: "user:alice" });
  kernel.userKernelMarker = activeMarker();
  kernel.activeTargetOperations = new Map();
  kernel.targetOperationDrainWaiters = new Map();
  kernel.appRuntimes = {
    getLifecycleFence: vi.fn(() => null),
  };
  kernel.projectionState = {
    packageFence: vi.fn(() => null),
  };
  kernel.procs = {
    get: vi.fn(() => processRecord(processGeneration)),
  };
  kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
  return kernel;
}

describe("Kernel process generation fencing", () => {
  it("rejects stale requests and signals before they mutate Kernel state", async () => {
    const kernel = userKernel(3);
    kernel.handleProcessReq = vi.fn();
    kernel.updateProcessRuntimeFromSignal = vi.fn();
    kernel.completeIpcCallsForProcessSignal = vi.fn();

    await expect(kernel.recvFrame("proc:alice", {
      type: "req",
      id: "stale-request",
      call: "fs.read",
      args: { path: "/private" },
    })).resolves.toEqual({
      type: "res",
      id: "stale-request",
      ok: false,
      error: {
        code: 410,
        message: "Process belongs to a stale user Kernel generation",
      },
    });
    await expect(kernel.recvFrame("proc:alice", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-stale" },
    })).resolves.toBeNull();

    expect(kernel.handleProcessReq).not.toHaveBeenCalled();
    expect(kernel.updateProcessRuntimeFromSignal).not.toHaveBeenCalled();
    expect(kernel.completeIpcCallsForProcessSignal).not.toHaveBeenCalled();
  });

  it("rejects stale authority handshakes before consulting account authority", async () => {
    const kernel = userKernel(3);
    kernel.auth = {
      getPasswdByUid: vi.fn(),
      resolveGids: vi.fn(),
    };

    await expect(kernel.resolveProcessAuthority("proc:alice", IDENTITY)).resolves.toEqual({
      ok: false,
      error: "process belongs to a stale user Kernel generation",
    });
    expect(kernel.auth.getPasswdByUid).not.toHaveBeenCalled();
    expect(kernel.auth.resolveGids).not.toHaveBeenCalled();
  });

  it("rejects stale device requests before target lookup", async () => {
    const kernel = userKernel(3);
    kernel.buildProcessContext = vi.fn();
    kernel.requestDevice = vi.fn();

    await expect(kernel.requestProcessNetFetch(
      "proc:alice",
      "laptop",
      { url: "https://example.com", timeoutMs: 1_000 },
    )).rejects.toThrow("Process belongs to a stale user Kernel generation");
    expect(kernel.buildProcessContext).not.toHaveBeenCalled();
    expect(kernel.requestDevice).not.toHaveBeenCalled();
  });

  it("drops stale cancellation attempts without touching a current request", async () => {
    const kernel = userKernel(3);
    const controller = new AbortController();
    kernel.activeRequests = new Map([["request-1", {
      origin: { type: "process", id: "proc:alice" },
      controller,
    }]]);
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: vi.fn(() => null) };

    await expect(kernel.cancelProcessRequests(
      "proc:alice",
      ["request-1"],
      "stale executor",
    )).resolves.toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it("cancels a device result when the Kernel generation changes in flight", async () => {
    const kernel = userKernel(4);
    const cancel = vi.fn();
    const device = {
      device_id: "laptop",
      owner_uid: IDENTITY.uid,
      label: "Laptop",
      description: "",
      implements: ["net.fetch"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1,
      last_seen_at: 1,
      connected_at: 1,
      disconnected_at: null,
    };
    kernel.buildProcessContext = vi.fn(() => ({
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["net.fetch"],
      },
      devices: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => device),
      },
      auth: { getPasswdByUid: vi.fn(() => ({ username: "alice" })) },
    }));
    kernel.requestDevice = vi.fn(async () => {
      kernel.userKernelMarker = activeMarker(5);
      return {
        type: "res",
        id: "request-1",
        ok: true,
        data: {
          ok: true,
          url: "https://example.com",
          status: 200,
          statusText: "OK",
          headers: {},
          redirected: false,
        },
        body: {
          stream: new ReadableStream<Uint8Array>({ cancel }),
          length: 1,
        },
      };
    });

    await expect(kernel.requestProcessNetFetch(
      "proc:alice",
      "laptop",
      { url: "https://example.com", timeoutMs: 1_000 },
    )).rejects.toThrow("User Kernel is not active");
    expect(cancel).toHaveBeenCalledWith("Process net.fetch result rejected");
  });
});
