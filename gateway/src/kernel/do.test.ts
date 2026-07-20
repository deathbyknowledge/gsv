import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { Kernel } from "./do";
import {
  USER_KERNEL_GENERATION_HEADER,
  USER_KERNEL_LOGIN_SOURCE_HEADER,
} from "../shared/kernel-names";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol";
import {
  buildRoutedAppSessionId,
  buildRoutedAppSessionSigningInput,
  parseRoutedAppSessionId,
} from "../protocol/app-session";
import {
  importAppPlacementVerificationKey,
  parseSerializedAppPlacementVerificationKeyRecord,
  verifyAppPlacementCertificate,
} from "../shared/app-placement-certificate";
import {
  isPackageAgentRuntimeAuthorized,
  packageAgentAccessGroup,
  packageAgentSecurityRevision,
} from "./package-agents";
import type { InstalledPackageRecord, PackageProfileManifest } from "./packages";

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);
const TEST_KERNEL_CAPABILITY = "a".repeat(64);
const TEST_APP_PLACEMENT_CERTIFICATE = "A".repeat(86);

function createKernel(): any {
  const kernel = Object.create(Kernel.prototype) as any;
  Object.defineProperty(kernel, "name", {
    value: "singleton",
    configurable: true,
  });
  kernel.userKernelMarker = null;
  kernel.activeTargetOperations = new Map();
  kernel.targetOperationDrainWaiters = new Map();
  kernel.activeScheduleRuns = new Map();
  kernel.activeRequests = new Map();
  kernel.transitioningUserKernels = new Set();
  kernel.activeMasterUserOperations = new Map();
  kernel.packageProjectionFenceAuthorizations = new Map();
  kernel.appRunnerRuntimeFenceAuthorizations = new Map();
  kernel.masterProjectionMutationTail = Promise.resolve();
  kernel.pendingMasterProjectionCommit = null;
  kernel.masterPackageProjectionTransitionPending = null;
  kernel.masterPackageFenceRecoveryQueued = false;
  kernel.masterPackageFenceRecoveryAttempt = 0;
  let masterRevision = 1;
  let pendingMasterRevision: number | null = null;
  let packageFence: { fenceId: string; kernelGeneration: number; startedAt: number } | null = null;
  kernel.projectionState = {
    packageFence: vi.fn(() => packageFence),
    masterRevision: vi.fn(() => masterRevision),
    pendingMasterRevision: vi.fn(() => pendingMasterRevision),
    recoverPendingMasterRevision: vi.fn(() => {
      if (pendingMasterRevision !== null) {
        masterRevision = pendingMasterRevision;
        pendingMasterRevision = null;
      }
      return masterRevision;
    }),
    installed: vi.fn(() => null),
    enterPackageFence: vi.fn((fence) => {
      packageFence = fence;
    }),
    clearPackageFence: vi.fn((fenceId, generation) => {
      if (packageFence?.fenceId !== fenceId || packageFence.kernelGeneration !== generation) {
        return false;
      }
      packageFence = null;
      return true;
    }),
    beginMasterMutation: vi.fn(() => {
      pendingMasterRevision = masterRevision + 1;
      return pendingMasterRevision;
    }),
    commitMasterMutation: vi.fn((revision) => {
      masterRevision = revision;
      pendingMasterRevision = null;
      return revision;
    }),
  };
  kernel.ctx = {
    storage: { transactionSync: (closure: () => unknown) => closure() },
    waitUntil: vi.fn(),
  };
  kernel.userKernels = {
    list: vi.fn(() => []),
    getByUid: vi.fn((uid: number) => ({
      username: uid === 0 ? "root" : `user-${uid}`,
      uid,
      lifecycle: "legacy",
      generation: 1,
    })),
  };
  const appRuntimeLifecycleFences = new Map<number, any>();
  kernel.appRuntimes = {
    rememberRunner: vi.fn((input) => ({
      ...input,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    })),
    getRunner: vi.fn(() => null),
    listRunners: vi.fn(() => []),
    beginLifecycleFence: vi.fn((fence) => {
      const existing = appRuntimeLifecycleFences.get(fence.ownerUid);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fence)) {
        throw new Error("A different AppRunner lifecycle fence is active");
      }
      appRuntimeLifecycleFences.set(fence.ownerUid, fence);
      return fence;
    }),
    getLifecycleFence: vi.fn((ownerUid: number) => (
      appRuntimeLifecycleFences.get(ownerUid) ?? null
    )),
    listLifecycleFences: vi.fn(() => [...appRuntimeLifecycleFences.values()]),
    clearLifecycleFence: vi.fn((expected) => {
      const existing = appRuntimeLifecycleFences.get(expected.ownerUid);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(expected)) {
        return false;
      }
      appRuntimeLifecycleFences.delete(expected.ownerUid);
      return true;
    }),
  };
  kernel.procs = { get: vi.fn(() => null), list: vi.fn(() => []) };
  kernel.schedules = {
    listStored: vi.fn(() => []),
    releaseInterruptedRuns: vi.fn(() => 0),
  };
  return kernel;
}

function installTestAppRuntimeRegistry(
  kernel: any,
  initialRunners: any[] = [],
  initialLifecycleFences: any[] = [],
): { runners: Map<string, any>; lifecycleFences: Map<number, any> } {
  const runners = new Map(initialRunners.map((runner) => [runner.runnerName, runner]));
  const lifecycleFences = new Map(
    initialLifecycleFences.map((fence) => [fence.ownerUid, fence]),
  );
  kernel.appRuntimes = {
    rememberRunner: vi.fn((input: any) => {
      const controlName = `app-control-v3:${input.kernelOwnerUid}:${input.ownerUid}:${encodeURIComponent(input.packageId)}`;
      const dataName = `app-data-v2:${input.kernelOwnerUid}:${input.ownerUid}:${encodeURIComponent(input.packageId)}`;
      if (input.runnerName !== controlName && input.runnerName !== dataName) {
        throw new Error("AppRunner name does not match its owner and package");
      }
      const existing = runners.get(input.runnerName);
      if (existing && (
        existing.ownerUid !== input.ownerUid
        || existing.ownerUsername !== input.ownerUsername
        || existing.kernelOwnerUid !== input.kernelOwnerUid
        || existing.kernelOwnerUsername !== input.kernelOwnerUsername
        || existing.packageId !== input.packageId
      )) {
        throw new Error("AppRunner registry identity conflict");
      }
      const remembered = existing ?? {
        ...input,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      runners.set(input.runnerName, remembered);
      return remembered;
    }),
    getRunner: vi.fn((runnerName: string) => runners.get(runnerName) ?? null),
    listRunners: vi.fn((kernelOwner?: {
      kernelOwnerUid: number;
      kernelOwnerUsername: string;
    }) => [...runners.values()].filter((runner) => !kernelOwner || (
      runner.kernelOwnerUid === kernelOwner.kernelOwnerUid
      && runner.kernelOwnerUsername === kernelOwner.kernelOwnerUsername
    ))),
    beginLifecycleFence: vi.fn((fence: any) => {
      const existing = lifecycleFences.get(fence.ownerUid);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fence)) {
        throw new Error("A different AppRunner lifecycle fence is active");
      }
      lifecycleFences.set(fence.ownerUid, existing ?? fence);
      return existing ?? fence;
    }),
    getLifecycleFence: vi.fn((ownerUid: number) => lifecycleFences.get(ownerUid) ?? null),
    listLifecycleFences: vi.fn(() => [...lifecycleFences.values()]),
    clearLifecycleFence: vi.fn((expected: any) => {
      const existing = lifecycleFences.get(expected.ownerUid);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(expected)) return false;
      lifecycleFences.delete(expected.ownerUid);
      return true;
    }),
  };
  return { runners, lifecycleFences };
}

describe("Kernel user lifecycle fencing", () => {
  it("persists the lifecycle fence before draining and commits the marker afterward", async () => {
    const requestController = new AbortController();
    const routeBodyCancel = vi.fn(async () => {});
    const orphanBodyCancel = vi.fn(async () => {});
    const pendingResponse = vi.fn();
    const closeBodyChannel = vi.fn();
    const userConnection = {
      id: "user-connection",
      state: {
        step: "connected",
        identity: {
          role: "user",
          process: { uid: 1000 },
        },
      },
      close: vi.fn(),
    };
    const driverConnection = {
      id: "driver-connection",
      state: {
        step: "connected",
        identity: {
          role: "driver",
          device: "laptop",
        },
      },
      close: vi.fn(),
    };
    const storagePut = vi.fn(async () => {});
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = { storage: { put: storagePut } };
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.isMasterUserKernelLifecycleAuthorized = vi.fn(async () => true);
    kernel.activeRequests = new Map([
      ["request-1", {
        origin: { type: "process", id: "process-1" },
        controller: requestController,
      }],
    ]);
    const scheduleController = new AbortController();
    kernel.activeScheduleRuns = new Map([["schedule-1", scheduleController]]);
    kernel.schedules = { releaseInterruptedRuns: vi.fn(() => 1) };
    kernel.cancelledProcessRequests = new Map([
      ["process-1\0old", { expiresAt: Date.now() + 10_000, reason: "old" }],
    ]);
    kernel.routes = {
      drain: vi.fn(() => [{
        id: "request-1",
        call: "fs.read",
        origin: { type: "process", id: "process-1" },
        deviceId: "laptop",
        driverConnectionId: "driver-connection",
        createdAt: 1,
        expiresAt: 2,
        scheduleId: "route-wake",
      }]),
    };
    kernel.routedBodies = new Map([
      ["request-1", { cancel: routeBodyCancel }],
      ["orphan", { cancel: orphanBodyCancel }],
    ]);
    kernel.pendingAppResponses = new Map([["app-1", pendingResponse]]);
    kernel.connections = new Map([
      [userConnection.id, userConnection],
      [driverConnection.id, driverConnection],
    ]);
    kernel.frameBodyChannels = new Map([
      [userConnection.id, { close: closeBodyChannel }],
    ]);
    kernel.devices = { setOnline: vi.fn() };
    kernel.runRoutes = {
      clearForConnection: vi.fn(),
      clearAll: vi.fn(),
    };
    kernel.cancelSchedule = vi.fn(async () => {});
    kernel.sendDeviceRequestCancel = vi.fn();
    kernel.deliverToOrigin = vi.fn();
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => {});

    const marker = await kernel.applyMasterUserKernelLifecycle({
      sourceKernelName: "singleton",
      authorization: "authorization-1",
      username: "alice",
      uid: 1000,
      expectedLifecycle: "active",
      expectedGeneration: 4,
      lifecycle: "suspended",
      generation: 5,
    });

    expect(storagePut).toHaveBeenCalledWith(
      "gsv/kernel/instance",
      expect.objectContaining({ lifecycle: "suspended", generation: 5 }),
    );
    expect(marker).toMatchObject({ lifecycle: "suspended", generation: 5 });
    expect(kernel.userKernelMarker).toEqual(marker);
    expect(requestController.signal.reason).toEqual(new Error("User Kernel is not active"));
    expect(kernel.activeRequests.size).toBe(0);
    expect(scheduleController.signal.reason).toEqual(new Error("User Kernel is not active"));
    expect(kernel.activeScheduleRuns.size).toBe(0);
    expect(kernel.schedules.releaseInterruptedRuns).toHaveBeenCalledWith(
      "User Kernel is not active",
    );
    expect(kernel.cancelledProcessRequests.size).toBe(0);
    expect(kernel.routes.drain).toHaveBeenCalledTimes(1);
    expect(kernel.sendDeviceRequestCancel).toHaveBeenCalledWith(
      "laptop",
      "driver-connection",
      "request-1",
      "User Kernel is not active",
    );
    expect(kernel.cancelSchedule).toHaveBeenCalledWith("route-wake");
    expect(routeBodyCancel).toHaveBeenCalledWith("User Kernel is not active");
    expect(orphanBodyCancel).toHaveBeenCalledWith("User Kernel is not active");
    expect(pendingResponse).toHaveBeenCalledWith(expect.objectContaining({
      type: "res",
      id: "app-1",
      ok: false,
    }));
    expect(userConnection.close).toHaveBeenCalledWith(1008, "Authentication failed");
    expect(driverConnection.close).toHaveBeenCalledWith(1008, "Authentication failed");
    expect(closeBodyChannel).toHaveBeenCalled();
    expect(kernel.devices.setOnline).toHaveBeenCalledWith("laptop", false);
    expect(kernel.connections.size).toBe(0);
    expect(kernel.runRoutes.clearAll).toHaveBeenCalledTimes(1);
    expect(kernel.abortFencedUserKernelProcesses).toHaveBeenCalledWith(
      4,
      "User Kernel is not active",
    );
    expect(kernel.appRuntimes.beginLifecycleFence.mock.invocationCallOrder[0]).toBeLessThan(
      kernel.abortFencedUserKernelProcesses.mock.invocationCallOrder[0],
    );
    expect(kernel.abortFencedUserKernelProcesses.mock.invocationCallOrder[0]).toBeLessThan(
      storagePut.mock.invocationCallOrder[0],
    );
  });

  it("exact-acks every old-generation process before completing the fence", async () => {
    const record = {
      processId: "process-1",
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
      ownerUid: 1000,
      kernelGeneration: 4,
      packageSecurityRevision: null,
      state: "running",
      activeRunId: "run-1",
      activeConversationId: "default",
      queuedCount: 2,
      createdAt: 1,
      lastActiveAt: 1,
    };
    const updateRuntimeState = vi.fn(() => true);
    const cancelBySourceRun = vi.fn();
    const completeByRun = vi.fn(() => []);
    const deleteRunRoute = vi.fn();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.procs = {
      list: vi.fn(() => [record]),
      get: vi.fn(() => record),
      getOwnerUid: vi.fn(() => 1000),
      updateRuntimeState,
    };
    kernel.ipcCalls = { cancelBySourceRun, completeByRun };
    kernel.runRoutes = { delete: deleteRunRoute };
    sendFrameToProcessMock.mockImplementation(async (_pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "unexpected",
      ok: true,
      data: { ok: true, pid: "process-1", aborted: true },
    }));

    try {
      await kernel.abortFencedUserKernelProcesses(4, "User Kernel is not active");

      expect(sendFrameToProcessMock).toHaveBeenCalledWith(
        "process-1",
        expect.objectContaining({
          type: "req",
          call: "proc.abort",
          args: {
            pid: "process-1",
            lifecycleFenceGeneration: 4,
          },
        }),
      );
      expect(updateRuntimeState).toHaveBeenCalledWith("process-1", expect.objectContaining({
        state: "queued",
        activeRunId: null,
        activeConversationId: null,
        queuedCount: 2,
      }));
      expect(cancelBySourceRun).toHaveBeenCalledWith({
        uid: 1000,
        sourcePid: "process-1",
        sourceRunId: "run-1",
      });
      expect(completeByRun).toHaveBeenCalledWith(expect.objectContaining({
        uid: 1000,
        targetPid: "process-1",
        runId: "run-1",
        error: "Target run was aborted: kernel.lifecycle",
      }));
      expect(deleteRunRoute).toHaveBeenCalledWith("run-1");
    } finally {
      sendFrameToProcessMock.mockReset();
    }
  });

  it("rejects a process that does not exact-ack the lifecycle fence", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.procs = {
      list: vi.fn(() => [{ processId: "process-1", kernelGeneration: 4 }]),
    };
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "wrong-request",
      ok: true,
      data: { ok: true, pid: "process-1" },
    });

    try {
      await expect(kernel.abortFencedUserKernelProcesses(4, "User Kernel is not active"))
        .rejects.toThrow("did not exact-ack lifecycle fence");
    } finally {
      sendFrameToProcessMock.mockReset();
    }
  });

  it("grants lifecycle abort authority only to the exact fenced generation", async () => {
    const identity = {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    };
    const record = {
      processId: "process-1",
      ...identity,
      ownerUid: 1000,
      kernelGeneration: 4,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 5,
      lifecycle: "suspended",
      updatedAt: 1,
    };
    kernel.procs = { get: vi.fn(() => record) };
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        username: "alice",
        password: "x",
        uid: 1000,
        gid: 1000,
        gecos: "",
        home: "/home/alice",
        shell: "/bin/gsv-agent",
      })),
      resolveGids: vi.fn(() => [1000]),
    };

    await expect(kernel.resolveProcessLifecycleFenceAuthority(
      "process-1",
      identity,
      4,
    )).resolves.toMatchObject({ ok: true });
    await expect(kernel.resolveProcessLifecycleFenceAuthority(
      "process-1",
      identity,
      3,
    )).resolves.toEqual({
      ok: false,
      error: "user Kernel lifecycle fence authority is unavailable",
    });

    kernel.userKernelMarker = { ...kernel.userKernelMarker, lifecycle: "active" };
    await expect(kernel.resolveProcessLifecycleFenceAuthority(
      "process-1",
      identity,
      4,
    )).resolves.toEqual({
      ok: false,
      error: "user Kernel lifecycle fence authority is unavailable",
    });
  });

  it("rebinds only owned processes from the immediately fenced generation", () => {
    const predecessor = {
      processId: "process-predecessor",
      ownerUid: 1000,
      kernelGeneration: 4,
    };
    const current = {
      processId: "process-current",
      ownerUid: 1000,
      kernelGeneration: 5,
    };
    const older = {
      processId: "process-older",
      ownerUid: 1000,
      kernelGeneration: 3,
    };
    const rebindKernelGeneration = vi.fn(() => true);
    const transactionSync = vi.fn((closure: () => unknown) => closure());
    const kernel = createKernel() as any;
    kernel.ctx = { storage: { transactionSync } };
    kernel.procs = {
      list: vi.fn(() => [predecessor, current, older]),
      rebindKernelGeneration,
    };

    kernel.rebindFencedUserKernelProcesses({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 5,
      lifecycle: "provisioning",
      updatedAt: 1,
    });

    expect(transactionSync).toHaveBeenCalledOnce();
    expect(rebindKernelGeneration).toHaveBeenCalledOnce();
    expect(rebindKernelGeneration).toHaveBeenCalledWith(
      "process-predecessor",
      4,
      5,
    );
  });

  it("fails closed when a fenced process has a different owner", () => {
    const kernel = createKernel() as any;
    kernel.ctx = {
      storage: {
        transactionSync: vi.fn((closure: () => unknown) => closure()),
      },
    };
    kernel.procs = {
      list: vi.fn(() => [{
        processId: "process-foreign",
        ownerUid: 2000,
        kernelGeneration: 4,
      }]),
      rebindKernelGeneration: vi.fn(),
    };

    expect(() => kernel.rebindFencedUserKernelProcesses({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 5,
      lifecycle: "provisioning",
      updatedAt: 1,
    })).toThrow("Fenced process owner does not match user Kernel");
    expect(kernel.procs.rebindKernelGeneration).not.toHaveBeenCalled();
  });

  it("grants teardown authority to current and immediate predecessor provisioning processes", async () => {
    const identity = {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    };
    const records = new Map([
      ["process-predecessor", {
        processId: "process-predecessor",
        ...identity,
        ownerUid: 1000,
        kernelGeneration: 4,
      }],
      ["process-current", {
        processId: "process-current",
        ...identity,
        ownerUid: 1000,
        kernelGeneration: 5,
      }],
      ["process-older", {
        processId: "process-older",
        ...identity,
        ownerUid: 1000,
        kernelGeneration: 3,
      }],
    ]);
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 5,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    kernel.procs = { get: vi.fn((processId: string) => records.get(processId)) };
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        username: "alice",
        password: "x",
        uid: 1000,
        gid: 1000,
        gecos: "",
        home: "/home/alice",
        shell: "/bin/gsv-agent",
      })),
      resolveGids: vi.fn(() => [1000]),
    };

    await expect(kernel.resolveProcessTeardownAuthority(
      "process-predecessor",
      identity,
    )).resolves.toMatchObject({ ok: true });
    await expect(kernel.resolveProcessTeardownAuthority(
      "process-current",
      identity,
    )).resolves.toMatchObject({ ok: true });
    await expect(kernel.resolveProcessTeardownAuthority(
      "process-older",
      identity,
    )).resolves.toEqual({
      ok: false,
      error: "process belongs to a stale user Kernel generation",
    });
  });

  it("does not commit a schedule result after its Kernel generation is fenced", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.activeScheduleRuns = new Map();
    kernel.schedules = {
      markRunning: vi.fn(() => ({})),
      finishRun: vi.fn(),
      setWakeScheduleId: vi.fn(),
    };
    kernel.resolveScheduleIdentity = vi.fn(() => ({
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    }));
    kernel.authorizeCurrentPackageAgentRuntime = vi.fn(async () => true);
    kernel.dispatchScheduleTarget = vi.fn(async () => {
      kernel.userKernelMarker = {
        ...kernel.userKernelMarker,
        generation: 5,
        lifecycle: "suspended",
      };
      return { kind: "command.exec", exitCode: 0 };
    });

    const result = await kernel.runScheduleRecord({
      id: "schedule-1",
      ownerUid: 1000,
      creator: { kind: "user", uid: 1000, username: "alice" },
      runAs: { kind: "user", uid: 1000, username: "alice" },
      name: "daily task",
      enabled: true,
      expression: { kind: "every", everyMs: 60_000 },
      target: { kind: "command.exec", command: "true" },
      overlapPolicy: "skip",
      createdAtMs: 1,
      updatedAtMs: 1,
      state: {
        nextRunAtMs: 1,
        runningAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runCount: 0,
      },
    }, "force");

    expect(result).toMatchObject({
      scheduleId: "schedule-1",
      status: "error",
      error: "User Kernel lifecycle changed during schedule run",
    });
    expect(kernel.schedules.finishRun).not.toHaveBeenCalled();
    expect(kernel.schedules.setWakeScheduleId).not.toHaveBeenCalled();
    expect(kernel.activeScheduleRuns.size).toBe(0);
  });

  it("rejects a lifecycle fence the Master did not authorize", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = { storage: { put: vi.fn() } };
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.isMasterUserKernelLifecycleAuthorized = vi.fn(async () => false);

    await expect(kernel.applyMasterUserKernelLifecycle({
      sourceKernelName: "singleton",
      authorization: "authorization-1",
      username: "alice",
      uid: 1000,
      expectedLifecycle: "active",
      expectedGeneration: 4,
      lifecycle: "suspended",
      generation: 5,
    })).rejects.toThrow("transition denied");
    expect(kernel.ctx.storage.put).not.toHaveBeenCalled();
  });

  it("finishes a retry fence when the Master barrier already advanced", async () => {
    const active = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    let persisted: unknown = active;
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = {
      waitUntil: vi.fn(),
      storage: {
        get: vi.fn(async () => persisted),
        put: vi.fn(async (_key: string, value: unknown) => {
          persisted = value;
        }),
      },
    };
    kernel.userKernelMarker = active;
    kernel.isMasterUserKernelLifecycleAuthorized = vi.fn(async () => true);
    kernel.fenceUserKernelRuntime = vi.fn();
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => {});

    await expect(kernel.applyMasterUserKernelLifecycle({
      sourceKernelName: "singleton",
      authorization: "retry-authorization",
      username: "alice",
      uid: 1000,
      expectedLifecycle: "suspended",
      expectedGeneration: 5,
      lifecycle: "suspended",
      generation: 5,
    })).resolves.toMatchObject({ lifecycle: "suspended", generation: 5 });
    expect(persisted).toMatchObject({ lifecycle: "suspended", generation: 5 });
    expect(kernel.fenceUserKernelRuntime).toHaveBeenCalledOnce();
    expect(kernel.abortFencedUserKernelProcesses).toHaveBeenCalledWith(
      5,
      "User Kernel is not active",
    );
  });

  it("authorizes only the exact next lifecycle marker", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 4,
        createdAt: 1,
        updatedAt: 1,
        retiredAt: null,
      })),
    };
    const transition = {
      targetKernelName: "user:alice",
      authorization: "authorization-1",
      username: "alice",
      uid: 1000,
      expectedLifecycle: "active",
      expectedGeneration: 4,
      lifecycle: "suspended",
      generation: 5,
    };
    const authorize = async (candidate: Record<string, unknown>) => {
      kernel.userKernelLifecycleAuthorizations = new Map([[
        "authorization-1",
        {
          expiresAt: Date.now() + 10_000,
          transition: {
            targetKernelName: transition.targetKernelName,
            username: transition.username,
            uid: transition.uid,
            expectedLifecycle: transition.expectedLifecycle,
            expectedGeneration: transition.expectedGeneration,
            lifecycle: transition.lifecycle,
            generation: transition.generation,
          },
        },
      ]]);
      return kernel.consumeUserKernelLifecycleAuthorization(candidate);
    };

    await expect(authorize(transition)).resolves.toBe(true);
    await expect(kernel.consumeUserKernelLifecycleAuthorization(transition))
      .resolves.toBe(false);
    await expect(authorize({
      ...transition,
      generation: 4,
    })).resolves.toBe(false);
    await expect(authorize({
      ...transition,
      targetKernelName: "user:bob",
    })).resolves.toBe(false);
    await expect(authorize({
      ...transition,
      lifecycle: "provisioning",
      generation: 4,
    })).resolves.toBe(false);
  });

  it("fences the target before committing the Master admission barrier", async () => {
    const events: string[] = [];
    const current = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
      createdAt: 1,
      updatedAt: 1,
      retiredAt: null,
    };
    const suspended = {
      ...current,
      lifecycle: "suspended",
      generation: 5,
      updatedAt: 2,
    };
    let placement = current;
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernelLifecycleAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => placement),
      suspend: vi.fn(() => {
        events.push("registry");
        placement = suspended;
        return suspended;
      }),
    };
    kernel.applyUserKernelLifecycleTargetFence = vi.fn(async (transition) => {
      events.push("target");
      expect(placement).toMatchObject({ lifecycle: "active", generation: 4 });
      expect(kernel.transitioningUserKernels.has("alice")).toBe(true);
      expect(transition).toMatchObject({
        sourceKernelName: "singleton",
        username: "alice",
        uid: 1000,
        expectedLifecycle: "active",
        expectedGeneration: 4,
        lifecycle: "suspended",
        generation: 5,
        authorization: expect.any(String),
      });
      return {
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        lifecycle: "suspended",
        generation: 5,
        updatedAt: 2,
      };
    });

    const releaseOperation = kernel.beginMasterUserOperation("alice");
    expect(releaseOperation).toEqual(expect.any(Function));
    const transitionPromise = kernel.transitionUserKernelLifecycle({
      username: "alice",
      expectedGeneration: 4,
      lifecycle: "suspended",
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(kernel.beginMasterUserOperation("alice")).toBeNull();
    releaseOperation();

    await expect(transitionPromise).resolves.toEqual(suspended);
    expect(events).toEqual(["target", "registry"]);
    expect(kernel.userKernels.suspend).toHaveBeenCalledWith("alice", 4);
    expect(kernel.userKernelLifecycleAuthorizations.size).toBe(0);
  });

  it("leaves the Master active when the target fence fails", async () => {
    const current = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
      createdAt: 1,
      updatedAt: 1,
      retiredAt: null,
    };
    let rejectFence!: (error: Error) => void;
    const fence = new Promise<never>((_resolve, reject) => {
      rejectFence = reject;
    });
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernelLifecycleAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => current),
      suspend: vi.fn(),
    };
    kernel.applyUserKernelLifecycleTargetFence = vi.fn(() => fence);

    const transition = kernel.transitionUserKernelLifecycle({
      username: "alice",
      expectedGeneration: 4,
      lifecycle: "suspended",
    });
    const rejected = expect(transition).rejects.toThrow("target fence unavailable");
    await vi.waitFor(() => {
      expect(kernel.applyUserKernelLifecycleTargetFence).toHaveBeenCalledOnce();
    });
    expect(kernel.beginMasterUserOperation("alice")).toBeNull();
    expect(kernel.userKernels.suspend).not.toHaveBeenCalled();

    rejectFence(new Error("target fence unavailable"));
    await rejected;

    expect(kernel.userKernels.get("alice")).toEqual(current);
    expect(kernel.userKernels.suspend).not.toHaveBeenCalled();
    expect(kernel.transitioningUserKernels.has("alice")).toBe(false);
    expect(kernel.userKernelLifecycleAuthorizations.size).toBe(0);
  });

  it("leaves the target fenced when the Master commit fails", async () => {
    const current = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
      createdAt: 1,
      updatedAt: 1,
      retiredAt: null,
    };
    let targetFenced = false;
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernelLifecycleAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => current),
      suspend: vi.fn(() => {
        throw new Error("Master commit failed");
      }),
    };
    kernel.applyUserKernelLifecycleTargetFence = vi.fn(async () => {
      targetFenced = true;
      return {
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        lifecycle: "suspended",
        generation: 5,
        updatedAt: 2,
      };
    });

    await expect(kernel.transitionUserKernelLifecycle({
      username: "alice",
      expectedGeneration: 4,
      lifecycle: "suspended",
    })).rejects.toThrow("Master commit failed");

    expect(targetFenced).toBe(true);
    expect(kernel.userKernels.get("alice")).toEqual(current);
    expect(kernel.userKernels.suspend).toHaveBeenCalledWith("alice", 4);
    expect(kernel.transitioningUserKernels.has("alice")).toBe(false);
  });

  it("denies stale-generation user calls into the Master", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 5,
      })),
    };
    kernel.resolveMasterSyscallIdentity = vi.fn();

    const result = await kernel.dispatchMasterSyscall({
      sourceKernelName: "user:alice",
      callerOwnerUid: 1000,
      generation: 4,
      kernelCapability: TEST_KERNEL_CAPABILITY,
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
        capabilities: ["account.create"],
      },
      frame: {
        type: "req",
        id: "request-1",
        call: "account.create",
        args: {},
      },
    });

    expect(result).toEqual({
      response: {
        type: "res",
        id: "request-1",
        ok: false,
        error: { code: 401, message: "Authentication failed" },
      },
      refreshProjection: false,
    });
    expect(kernel.resolveMasterSyscallIdentity).not.toHaveBeenCalled();
  });
});

describe("Kernel user provisioning admission", () => {
  const kernelCapability = "a".repeat(64);
  const snapshot = {
    version: 1 as const,
    username: "alice",
    uid: 1000,
    generation: 4,
    projectionRevision: 1,
    accounts: [{
      entry: {
        username: "alice",
        uid: 1000,
        gid: 1000,
        gecos: "Alice",
        home: "/home/alice",
        shell: "/bin/sh",
      },
      kind: "human" as const,
      locked: false,
    }],
    groups: [],
    personalAgentUid: null,
    capabilities: [],
    config: [],
    packages: [],
  };
  const authorization = {
    targetKernelName: "user:alice",
    authorization: "provision-1",
    username: "alice",
    uid: 1000,
    generation: 4,
  };

  function buildMaster() {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernelProvisioningAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "provisioning",
        generation: 4,
      })),
    };
    kernel.buildUserKernelProjection = vi.fn(() => snapshot);
    return kernel;
  }

  function authorize(kernel: any): void {
    kernel.userKernelProvisioningAuthorizations.set("provision-1", {
      expiresAt: Date.now() + 10_000,
      kernelCapability,
      provisioning: {
        targetKernelName: "user:alice",
        username: "alice",
        uid: 1000,
        generation: 4,
      },
    });
  }

  it("returns Master-owned provisioning state exactly once", async () => {
    const kernel = buildMaster();
    authorize(kernel);

    await expect(kernel.consumeUserKernelProvisioningAuthorization(authorization))
      .resolves.toEqual({ ...snapshot, kernelCapability });
    await expect(kernel.consumeUserKernelProvisioningAuthorization(authorization))
      .resolves.toBeNull();
    expect(kernel.buildUserKernelProjection).toHaveBeenCalledWith("alice");
  });

  it("deletes a provisioning authorization before rejecting tampering", async () => {
    const kernel = buildMaster();
    authorize(kernel);

    await expect(kernel.consumeUserKernelProvisioningAuthorization({
      ...authorization,
      generation: 5,
    })).resolves.toBeNull();
    await expect(kernel.consumeUserKernelProvisioningAuthorization(authorization))
      .resolves.toBeNull();
    expect(kernel.buildUserKernelProjection).not.toHaveBeenCalled();
  });

  it("confirms target activation exactly once only after Master is active", async () => {
    const kernel = buildMaster();
    kernel.userKernelActivationAuthorizations = new Map();
    kernel.userKernels.get = vi.fn(() => ({
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    }));
    kernel.verifyUserKernelCapabilityRecord = vi.fn(async () => true);
    kernel.buildUserKernelProjection = vi.fn(() => snapshot);
    kernel.userKernelActivationAuthorizations.set("activate-1", {
      expiresAt: Date.now() + 10_000,
      activation: {
        targetKernelName: "user:alice",
        username: "alice",
        uid: 1000,
        generation: 4,
      },
    });
    const activation = {
      targetKernelName: "user:alice",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 4,
      kernelCapability,
    };

    await expect(kernel.consumeUserKernelActivationAuthorization(activation))
      .resolves.toEqual(snapshot);
    await expect(kernel.consumeUserKernelActivationAuthorization(activation))
      .resolves.toBeNull();
    expect(kernel.verifyUserKernelCapabilityRecord)
      .toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "active" }), kernelCapability);
  });

  it("rejects direct provisioning without a live Master authorization", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    };
    kernel.pullAuthorizedUserKernelProvisioningSnapshot = vi.fn(async () => null);
    kernel.initializeUserKernelProvisioning = vi.fn(async () => undefined);

    await expect(kernel.provisionUserKernel({
      sourceKernelName: "singleton",
      authorization: "forged",
      username: "alice",
      uid: 1000,
      generation: 4,
    })).rejects.toThrow("provisioning denied");
    expect(kernel.ctx.storage.put).not.toHaveBeenCalled();

    await expect(kernel.provisionUserKernel(snapshot)).rejects.toThrow("provisioning denied");
    expect(kernel.pullAuthorizedUserKernelProvisioningSnapshot).toHaveBeenCalledTimes(1);
  });

  it("cannot overwrite a concurrent lifecycle fence when activating", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    let persisted: unknown;
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => persisted),
        put: vi.fn(async (key: string, value: unknown) => {
          if (key === "gsv/kernel/instance") persisted = value;
        }),
      },
    };
    kernel.pullAuthorizedUserKernelProvisioningSnapshot = vi.fn(async () => ({
      ...snapshot,
      kernelCapability,
    }));
    kernel.initializeUserKernelProvisioning = vi.fn(async () => {
      const suspended = {
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        generation: 5,
        lifecycle: "suspended",
        updatedAt: Date.now(),
      };
      persisted = suspended;
      kernel.userKernelMarker = suspended;
      return "proc:provisioning";
    });
    kernel.procs = {
      get: vi.fn(() => ({
        processId: "proc:provisioning",
        kernelGeneration: 4,
      })),
    };
    kernel.rollbackProvisionedUserKernelExecutor = vi.fn();

    await expect(kernel.provisionUserKernel({
      sourceKernelName: "singleton",
      authorization: "provision-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    })).rejects.toThrow("lifecycle changed during provisioning");
    expect(persisted).toMatchObject({ lifecycle: "suspended", generation: 5 });
    expect(kernel.ctx.storage.put).toHaveBeenCalledTimes(2);
    expect(kernel.rollbackProvisionedUserKernelExecutor)
      .toHaveBeenCalledWith("proc:provisioning");
  });

  it("binds the reserved generation to the provisioning-only Kernel context", () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const provisioning = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    kernel.userKernelMarker = provisioning;
    const getByName = vi.fn((name: string) => ({ name }));
    kernel.ctx = {
      exports: { AppRunner: { getByName } },
      storage: {
        transactionSync: vi.fn((closure: () => unknown) => closure()),
      },
      waitUntil: vi.fn(),
    };

    const context = kernel.buildKernelContext({
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000, 100],
          username: "alice",
          home: "/home/alice",
          cwd: "/home/alice",
        },
        capabilities: ["proc.*"],
      },
      provisioningMarker: provisioning,
    });

    expect(context.kernelGeneration).toBe(4);
    expect(context.kernelOwnerUid).toBe(1000);
    expect(context.getAppRunner(0, "pkg-chat")).toEqual({
      name: "app-control-v3:1000:0:pkg-chat",
    });
    expect(getByName).toHaveBeenCalledWith("app-control-v3:1000:0:pkg-chat");
    expect(context.assertCurrentKernel).not.toThrow();

    kernel.userKernelMarker = {
      ...provisioning,
      lifecycle: "suspended",
      generation: 5,
      updatedAt: 2,
    };
    expect(context.assertCurrentKernel).toThrow(
      "User Kernel lifecycle changed during provisioning",
    );
  });

  it("kills an initialized Process DO before clearing its durable binding", async () => {
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "signal",
      ok: true,
      data: { ok: true },
    }));
    const clearActivePid = vi.fn();
    const kill = vi.fn();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    kernel.processRollbackAuthorizations = new Map();
    kernel.ctx = {
      storage: {
        transactionSync: vi.fn((closure: () => unknown) => closure()),
      },
    };
    kernel.conversations = { clearActivePid };
    kernel.procs = { kill };

    await kernel.rollbackProvisionedUserKernelExecutor("proc:provisioning");

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc:provisioning",
      expect.objectContaining({
        call: "proc.kill",
        args: expect.objectContaining({
          pid: "proc:provisioning",
          archive: false,
          rollbackAuthorization: expect.any(String),
          rollbackKernelName: "user:alice",
        }),
      }),
    );
    expect(sendFrameToProcessMock.mock.invocationCallOrder.at(-1))
      .toBeLessThan(clearActivePid.mock.invocationCallOrder[0]);
    expect(clearActivePid).toHaveBeenCalledWith("proc:provisioning");
    expect(kill).toHaveBeenCalledWith("proc:provisioning");
  });

  it("consumes an exact process rollback capability only in the bound generation", async () => {
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = marker;
    kernel.processRollbackAuthorizations = new Map();
    const authorization = kernel.issueProcessRollbackAuthorization("proc:prepared", 4);

    await expect(kernel.consumeProcessRollbackAuthorization({
      authorization,
      processId: "proc:other",
    })).resolves.toBe(false);
    await expect(kernel.consumeProcessRollbackAuthorization({
      authorization,
      processId: "proc:prepared",
    })).resolves.toBe(false);

    const currentAuthorization = kernel.issueProcessRollbackAuthorization("proc:prepared", 4);
    await expect(kernel.consumeProcessRollbackAuthorization({
      authorization: currentAuthorization,
      processId: "proc:prepared",
    })).resolves.toBe(true);
    await expect(kernel.consumeProcessRollbackAuthorization({
      authorization: currentAuthorization,
      processId: "proc:prepared",
    })).resolves.toBe(false);

    const staleAuthorization = kernel.issueProcessRollbackAuthorization("proc:prepared", 4);
    kernel.userKernelMarker = { ...marker, lifecycle: "suspended", generation: 5 };
    await expect(kernel.consumeProcessRollbackAuthorization({
      authorization: staleAuthorization,
      processId: "proc:prepared",
    })).resolves.toBe(false);
  });

  it("rejects activation before Master contact when the local capability is corrupt", async () => {
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = marker;
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => ({
          version: 1,
          username: "alice",
          uid: 1000,
          generation: 4,
          secret: "corrupt",
        })),
      },
    };
    kernel.queueAppRuntimeLifecycleFenceRecovery = vi.fn();
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn();

    await expect(kernel.activateProvisionedUserKernel({
      sourceKernelName: "singleton",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    })).rejects.toThrow("capability is unavailable");
    expect(kernel.pullAuthorizedUserKernelActivationProjection).not.toHaveBeenCalled();
  });

  it("rejects a stale Master projection before executor initialization", async () => {
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = marker;
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => ({
          version: 1,
          username: "alice",
          uid: 1000,
          generation: 4,
          secret: kernelCapability,
        })),
      },
    };
    kernel.queueAppRuntimeLifecycleFenceRecovery = vi.fn();
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn(async () => ({
      ...snapshot,
      generation: 3,
    }));
    kernel.installUserKernelProjection = vi.fn(async () => undefined);
    kernel.ensureUserKernelProvisioningExecutor = vi.fn();

    let activationError: unknown;
    try {
      await kernel.activateProvisionedUserKernel({
        sourceKernelName: "singleton",
        authorization: "activate-1",
        username: "alice",
        uid: 1000,
        generation: 4,
      });
    } catch (error) {
      activationError = error;
    }
    expect(activationError).toEqual(new Error("User Kernel activation projection mismatch"));
    expect(kernel.installUserKernelProjection).not.toHaveBeenCalled();
    expect(kernel.ensureUserKernelProvisioningExecutor).not.toHaveBeenCalled();
  });

  it("demotes a recovery-fenced active target when projection installation fails", async () => {
    const active = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    let persisted: unknown = active;
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    installTestAppRuntimeRegistry(kernel, [], [{
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 4,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    }]);
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => persisted),
        put: vi.fn(async (_key: string, value: unknown) => {
          persisted = value;
        }),
      },
    };
    kernel.userKernelMarker = active;
    kernel.requireLocalUserKernelCapability = vi.fn(async () => kernelCapability);
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn(async () => snapshot);
    kernel.installUserKernelProjection = vi.fn(async () => {
      throw new Error("projection install failed");
    });
    kernel.ensureUserKernelProvisioningExecutor = vi.fn();
    kernel.discardPreparedUserKernelExecutors = vi.fn(async () => undefined);
    kernel.fenceUserKernelRuntime = vi.fn();
    kernel.cancelPendingScheduleWakes = vi.fn(async () => undefined);
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => undefined);
    kernel.queueAppRuntimeLifecycleFenceRecovery = vi.fn();

    await expect(kernel.activateProvisionedUserKernel({
      sourceKernelName: "singleton",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    })).rejects.toThrow("projection install failed");

    expect(persisted).toMatchObject({ lifecycle: "provisioning", generation: 4 });
    expect(kernel.userKernelMarker).toMatchObject({ lifecycle: "provisioning" });
    expect(kernel.fenceUserKernelRuntime)
      .toHaveBeenCalledWith("User Kernel activation failed");
    expect(kernel.cancelPendingScheduleWakes).toHaveBeenCalledOnce();
    expect(kernel.discardPreparedUserKernelExecutors).not.toHaveBeenCalled();
    expect(kernel.abortFencedUserKernelProcesses).toHaveBeenCalledWith(
      4,
      "User Kernel activation failed",
    );
    expect(kernel.ensureUserKernelProvisioningExecutor).not.toHaveBeenCalled();
    expect(kernel.queueAppRuntimeLifecycleFenceRecovery).toHaveBeenCalledWith(1);
  });

  it("restores a non-active marker and preserves the executor when rearming fails", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const provisioning = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    let persisted: unknown = provisioning;
    kernel.ctx = {
      waitUntil: vi.fn(),
      storage: {
        get: vi.fn(async () => persisted),
        put: vi.fn(async (key: string, value: unknown) => {
          if (key === "gsv/kernel/instance") persisted = value;
        }),
        transactionSync: vi.fn((closure: () => unknown) => closure()),
      },
    };
    kernel.userKernelMarker = provisioning;
    kernel.requireLocalUserKernelCapability = vi.fn(async () => kernelCapability);
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn(async () => snapshot);
    kernel.installUserKernelProjection = vi.fn(async () => undefined);
    kernel.discardPreparedUserKernelExecutors = vi.fn(async () => undefined);
    kernel.rebindFencedUserKernelProcesses = vi.fn();
    kernel.ensureUserKernelProvisioningExecutor = vi.fn(async () => "proc:provisioning");
    kernel.rollbackProvisionedUserKernelExecutor = vi.fn();
    kernel.rearmPendingSchedules = vi.fn(async () => {
      throw new Error("schedule rearm failed");
    });
    kernel.fenceUserKernelRuntime = vi.fn();
    kernel.cancelPendingScheduleWakes = vi.fn(async () => undefined);
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => undefined);

    await expect(kernel.activateProvisionedUserKernel({
      sourceKernelName: "singleton",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    })).rejects.toThrow("schedule rearm failed");

    expect(persisted).toMatchObject({ lifecycle: "provisioning", generation: 4 });
    expect(kernel.userKernelMarker).toMatchObject({ lifecycle: "provisioning" });
    expect(kernel.fenceUserKernelRuntime)
      .toHaveBeenCalledWith("User Kernel activation failed");
    expect(kernel.cancelPendingScheduleWakes).toHaveBeenCalledOnce();
    expect(kernel.rollbackProvisionedUserKernelExecutor).not.toHaveBeenCalled();
    expect(kernel.abortFencedUserKernelProcesses).toHaveBeenCalledWith(
      4,
      "User Kernel activation failed",
    );
  });

  it("prepares without rearming and rearms only after Master confirms activation", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    let persisted: unknown;
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => persisted),
        put: vi.fn(async (key: string, value: unknown) => {
          if (key === "gsv/kernel/instance") persisted = value;
        }),
      },
    };
    kernel.pullAuthorizedUserKernelProvisioningSnapshot = vi.fn(async () => ({
      ...snapshot,
      kernelCapability,
    }));
    kernel.initializeUserKernelProvisioning = vi.fn(async () => "proc:provisioning");
    kernel.rearmPendingSchedules = vi.fn(async () => undefined);

    const prepared = await kernel.provisionUserKernel({
      sourceKernelName: "singleton",
      authorization: "provision-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    });

    expect(prepared).toMatchObject({ lifecycle: "provisioning", generation: 4 });
    expect(kernel.ctx.storage.put).toHaveBeenCalledWith(
      "gsv/kernel/capability/v1",
      {
        version: 1,
        username: "alice",
        uid: 1000,
        generation: 4,
        secret: kernelCapability,
      },
    );
    expect(kernel.rearmPendingSchedules).not.toHaveBeenCalled();

    kernel.requireLocalUserKernelCapability = vi.fn(async () => kernelCapability);
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn(async () => snapshot);
    kernel.installUserKernelProjection = vi.fn(async () => undefined);
    kernel.discardPreparedUserKernelExecutors = vi.fn(async () => undefined);
    kernel.rebindFencedUserKernelProcesses = vi.fn();
    kernel.ensureUserKernelProvisioningExecutor = vi.fn(async () => "proc:provisioning");
    const marker = await kernel.activateProvisionedUserKernel({
      sourceKernelName: "singleton",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 4,
    });

    expect(marker).toMatchObject({ lifecycle: "active", generation: 4 });
    expect(kernel.installUserKernelProjection.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.ensureUserKernelProvisioningExecutor.mock.invocationCallOrder[0]);
    expect(kernel.discardPreparedUserKernelExecutors.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.rebindFencedUserKernelProcesses.mock.invocationCallOrder[0]);
    expect(kernel.rebindFencedUserKernelProcesses.mock.invocationCallOrder[0])
      .toBeLessThan(kernel.ensureUserKernelProvisioningExecutor.mock.invocationCallOrder[0]);
    expect(kernel.rearmPendingSchedules).toHaveBeenCalledTimes(2);
    expect(kernel.rearmPendingSchedules).toHaveBeenNthCalledWith(
      1,
      marker,
      { allowLifecycleFence: true },
    );
    expect(kernel.rearmPendingSchedules).toHaveBeenNthCalledWith(2, marker);
  });
});

describe("Kernel inter-object capability", () => {
  it("stores only a digest and rejects tampered, rotated, or stale-generation proofs", async () => {
    const values = new Map<string, unknown>();
    let placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.ctx = {
      storage: {
        get: vi.fn(async (key: string) => values.get(key)),
        put: vi.fn(async (key: string, value: unknown) => values.set(key, value)),
      },
    };
    kernel.userKernels = { get: vi.fn(() => placement) };

    const first = await kernel.rotateUserKernelCapability(placement);
    const stored = values.get("gsv/kernel/user-capability/v1/alice");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(first);
    await expect(kernel.authorizeUserKernelCapability({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: first,
    })).resolves.toEqual(placement);
    await expect(kernel.authorizeUserKernelCapability({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: "f".repeat(64),
    })).resolves.toBeNull();

    const second = await kernel.rotateUserKernelCapability(placement);
    expect(second).not.toBe(first);
    await expect(kernel.authorizeUserKernelCapability({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: first,
    })).resolves.toBeNull();
    await expect(kernel.authorizeUserKernelCapability({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: second,
    })).resolves.toEqual(placement);

    placement = { ...placement, lifecycle: "suspended", generation: 5 };
    await expect(kernel.authorizeUserKernelCapability({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: second,
    })).resolves.toBeNull();
  });

  it("single-flights provisioning, clears failed flights, and proves the digest before activation", async () => {
    const preparedMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    const activeMarker = { ...preparedMarker, lifecycle: "active" };
    let placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "provisioning",
      generation: 4,
    };
    let rejectFirst!: (reason: Error) => void;
    const firstTargetCall = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const provisionUserKernel = vi.fn()
      .mockReturnValueOnce(firstTargetCall)
      .mockResolvedValueOnce(preparedMarker);
    const target = {
      setName: vi.fn(async () => undefined),
      provisionUserKernel,
      activateProvisionedUserKernel: vi.fn(async () => activeMarker),
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };
    kernel.userKernelProvisioningFlights = new Map();
    kernel.userKernelProvisioningAuthorizations = new Map();
    kernel.userKernelActivationAuthorizations = new Map();
    kernel.transitioningUserKernels = new Set();
    kernel.userKernels = {
      get: vi.fn(() => placement),
      markActive: vi.fn(() => {
        placement = { ...placement, lifecycle: "active" };
        return placement;
      }),
    };
    kernel.rotateUserKernelCapability = vi.fn()
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64));
    kernel.verifyUserKernelCapabilityRecord = vi.fn(async () => true);

    const first = kernel.ensureUserKernelProvisioned("alice");
    const joined = kernel.ensureUserKernelProvisioned("alice");
    await vi.waitFor(() => expect(provisionUserKernel).toHaveBeenCalledTimes(1));
    rejectFirst(new Error("target unavailable"));
    const failed = await Promise.allSettled([first, joined]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(kernel.rotateUserKernelCapability).toHaveBeenCalledTimes(1);
    expect(kernel.userKernelProvisioningFlights.size).toBe(0);

    await expect(kernel.ensureUserKernelProvisioned("alice")).resolves.toMatchObject({
      lifecycle: "active",
      generation: 4,
    });
    expect(provisionUserKernel).toHaveBeenCalledTimes(2);
    expect(kernel.rotateUserKernelCapability).toHaveBeenCalledTimes(2);
    expect(kernel.verifyUserKernelCapabilityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "provisioning", generation: 4 }),
      "b".repeat(64),
    );
    expect(kernel.userKernels.markActive).toHaveBeenCalledOnce();
    expect(target.activateProvisionedUserKernel).toHaveBeenCalledOnce();
    expect(kernel.userKernels.markActive.mock.invocationCallOrder[0])
      .toBeLessThan(target.activateProvisionedUserKernel.mock.invocationCallOrder[0]);
  });

  it("does not activate a target when the final persisted capability proof fails", async () => {
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "provisioning",
      generation: 4,
    };
    const target = {
      setName: vi.fn(async () => undefined),
      provisionUserKernel: vi.fn(async () => ({
        version: 1,
        kind: "user",
        ...placement,
        lifecycle: "provisioning",
        updatedAt: 1,
      })),
      activateProvisionedUserKernel: vi.fn(),
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };
    kernel.userKernelProvisioningFlights = new Map();
    kernel.userKernelProvisioningAuthorizations = new Map();
    kernel.userKernelActivationAuthorizations = new Map();
    kernel.transitioningUserKernels = new Set();
    kernel.userKernels = {
      get: vi.fn(() => placement),
      markActive: vi.fn(),
    };
    kernel.rotateUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    kernel.verifyUserKernelCapabilityRecord = vi.fn(async () => false);

    await expect(kernel.ensureUserKernelProvisioned("alice"))
      .rejects.toThrow("capability activation failed");
    expect(kernel.userKernels.markActive).not.toHaveBeenCalled();
  });

  it("retries target activation without reprovisioning after Master commit", async () => {
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    const activeMarker = {
      version: 1,
      kind: "user",
      ...placement,
      updatedAt: 1,
    };
    const target = {
      setName: vi.fn(async () => undefined),
      provisionUserKernel: vi.fn(),
      activateProvisionedUserKernel: vi.fn()
        .mockRejectedValueOnce(new Error("target unavailable after Master commit"))
        .mockResolvedValueOnce(activeMarker),
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };
    kernel.userKernelProvisioningFlights = new Map();
    kernel.userKernelProvisioningAuthorizations = new Map();
    kernel.userKernelActivationAuthorizations = new Map();
    kernel.transitioningUserKernels = new Set();
    kernel.userKernels = { get: vi.fn(() => placement) };

    await expect(kernel.ensureUserKernelProvisioned("alice"))
      .rejects.toThrow("target unavailable after Master commit");
    expect(kernel.userKernelProvisioningFlights.size).toBe(0);
    await expect(kernel.ensureUserKernelProvisioned("alice"))
      .resolves.toEqual(placement);

    expect(target.provisionUserKernel).not.toHaveBeenCalled();
    expect(target.activateProvisionedUserKernel).toHaveBeenCalledTimes(2);
  });
});

describe("Kernel adapter inbound admission", () => {
  const link = {
    adapter: "discord",
    accountId: "primary",
    actorId: "actor-1",
    uid: 1000,
    generation: 3,
  };
  const authorization = {
    authorization: "delivery-1",
    targetKernelName: "user:alice",
    username: "alice",
    ownerUid: 1000,
    generation: 7,
    adapter: "discord",
    accountId: "primary",
    actorId: "actor-1",
    linkGeneration: 3,
    frameId: "request-1",
    surfaceKind: "dm" as const,
    surfaceId: "surface-1",
  };
  const frame = {
    type: "req" as const,
    id: "request-1",
    call: "adapter.inbound" as const,
    args: {
      adapter: " Discord ",
      accountId: " primary ",
      message: {
        messageId: "message-1",
        surface: { kind: "dm" as const, id: "surface-1" },
        actor: { id: " actor-1 " },
        text: "hello",
      },
    },
  };

  function buildMaster() {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.adapterInboundAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 7,
      })),
      getByUid: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 7,
      })),
    };
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => link),
        isCurrentGeneration: vi.fn(() => true),
      },
      linkChallenges: {
        issue: vi.fn(() => ({
          code: "ABCD-2345",
          expiresAt: 20_000,
        })),
      },
    };
    return kernel;
  }

  function authorize(kernel: any): void {
    const { authorization: _authorization, ...delivery } = authorization;
    kernel.adapterInboundAuthorizations.set("delivery-1", {
      expiresAt: Date.now() + 10_000,
      delivery,
    });
  }

  it("issues a compact active route without calling or receiving a target frame", async () => {
    const kernel = buildMaster();

    const result = await kernel.issueAdapterInboundRoute({
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    });

    expect(result).toMatchObject({
      kind: "active",
      targetKernelName: "user:alice",
      username: "alice",
      ownerUid: 1000,
      generation: 7,
      linkGeneration: 3,
    });
    expect(result).not.toHaveProperty("frame");
    expect(result).not.toHaveProperty("message");
    expect(kernel.adapterInboundAuthorizations.size).toBe(1);
  });

  it("handles unknown actors from bounded surface metadata only", async () => {
    const kernel = buildMaster();
    kernel.adapters.identityLinks.get.mockReturnValue(null);

    await expect(kernel.issueAdapterInboundRoute({
      adapter: "discord",
      accountId: "primary",
      actorId: "new-actor",
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    })).resolves.toMatchObject({
      kind: "response",
      data: {
        ok: true,
        challenge: { code: "ABCD-2345", expiresAt: 20_000 },
      },
    });
    expect(kernel.adapters.linkChallenges.issue).toHaveBeenCalledWith({
      adapter: "discord",
      accountId: "primary",
      actorId: "new-actor",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    });

    await expect(kernel.issueAdapterInboundRoute({
      adapter: "discord",
      accountId: "primary",
      actorId: "new-actor",
      frameId: "request-2",
      surfaceKind: "channel",
      surfaceId: "surface-2",
    })).resolves.toEqual({
      kind: "response",
      data: { ok: true, droppedReason: "unlinked_actor" },
    });
  });

  it("rejects payload fields on the metadata-only Master route boundary", async () => {
    const kernel = buildMaster();

    await expect(kernel.issueAdapterInboundRoute({
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
      message: { text: "must not cross" },
    })).resolves.toEqual({
      kind: "error",
      code: 400,
      message: "Invalid adapter request",
    });
    expect(kernel.adapters.identityLinks.get).not.toHaveBeenCalled();
  });

  it("returns an explicit legacy route and denies non-active placements", async () => {
    const kernel = buildMaster();
    const metadata = {
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    };
    kernel.userKernels.getByUid.mockReturnValue({
      username: "alice",
      uid: 1000,
      lifecycle: "legacy",
      generation: 1,
    });
    await expect(kernel.issueAdapterInboundRoute(metadata)).resolves.toEqual({
      kind: "legacy",
    });

    kernel.userKernels.getByUid.mockReturnValue({
      username: "alice",
      uid: 1000,
      lifecycle: "suspended",
      generation: 8,
    });
    await expect(kernel.issueAdapterInboundRoute(metadata)).resolves.toEqual({
      kind: "error",
      code: 503,
      message: "Adapter owner is unavailable",
    });
  });

  it("consumes an exact active placement and link only once", async () => {
    const kernel = buildMaster();
    authorize(kernel);

    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(true);
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);
  });

  it("deletes authorization before rejecting tampering or an unlinked actor", async () => {
    const kernel = buildMaster();
    authorize(kernel);

    await expect(kernel.consumeAdapterInboundAuthorization({
      ...authorization,
      frameId: "request-2",
    })).resolves.toBe(false);
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);

    authorize(kernel);
    kernel.adapters.identityLinks.get.mockReturnValue(null);
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);
    kernel.adapters.identityLinks.get.mockReturnValue(link);
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);
  });

  it("denies a grant after either placement lifecycle or link generation changes", async () => {
    const kernel = buildMaster();
    authorize(kernel);
    kernel.userKernels.get.mockReturnValue({
      username: "alice",
      uid: 1000,
      lifecycle: "suspended",
      generation: 8,
    });
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);

    authorize(kernel);
    kernel.userKernels.get.mockReturnValue({
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
    });
    kernel.adapters.identityLinks.isCurrentGeneration.mockReturnValue(false);
    await expect(kernel.consumeAdapterInboundAuthorization(authorization))
      .resolves.toBe(false);
  });

  it("normalizes the frame and consumes immediately before dispatch", async () => {
    const events: string[] = [];
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
      updatedAt: 1,
    };
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
      updatedAt: 1,
    }));
    kernel.isMasterAdapterInboundAuthorized = vi.fn(async () => {
      events.push("consume");
      return true;
    });
    kernel.handleServiceReq = vi.fn(async () => {
      events.push("dispatch");
      return { type: "res", id: "request-1", ok: true, data: { ok: true } };
    });

    await expect(kernel.serviceLinkedAdapterFrame({
      source: "scoped-adapter-entrypoint",
      authorization: "delivery-1",
      username: "alice",
      ownerUid: 1000,
      generation: 7,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 3,
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
      frame,
    })).resolves.toMatchObject({ ok: true });
    expect(events).toEqual(["consume", "dispatch"]);
    expect(kernel.isMasterAdapterInboundAuthorized).toHaveBeenCalledWith(authorization);
  });

  it("rechecks the exact active generation after Master admission", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
      updatedAt: 1,
    };
    kernel.isMasterAdapterInboundAuthorized = vi.fn(async () => {
      kernel.userKernelMarker = {
        ...kernel.userKernelMarker,
        lifecycle: "suspended",
        generation: 8,
        updatedAt: 2,
      };
      return true;
    });
    kernel.handleServiceReq = vi.fn();

    await expect(kernel.serviceLinkedAdapterFrame({
      source: "scoped-adapter-entrypoint",
      authorization: "delivery-1",
      username: "alice",
      ownerUid: 1000,
      generation: 7,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 3,
      frameId: "request-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
      frame,
    })).resolves.toMatchObject({ ok: false, error: { code: 401 } });
    expect(kernel.handleServiceReq).not.toHaveBeenCalled();
  });

  it("rejects frame tampering and replay before local dispatch", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
      updatedAt: 1,
    };
    kernel.requireActiveUserKernel = vi.fn(async () => ({
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 7,
      updatedAt: 1,
    }));
    kernel.isMasterAdapterInboundAuthorized = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    kernel.handleServiceReq = vi.fn(async () => ({
      type: "res",
      id: "request-1",
      ok: true,
      data: { ok: true },
    }));
    const input = {
      source: "scoped-adapter-entrypoint",
      authorization: "delivery-1",
      username: "alice",
      ownerUid: 1000,
      generation: 7,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 3,
      frameId: "request-1",
      surfaceKind: "dm" as const,
      surfaceId: "surface-1",
      frame,
    };

    await expect(kernel.serviceLinkedAdapterFrame(input)).resolves.toMatchObject({ ok: true });
    await expect(kernel.serviceLinkedAdapterFrame(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 401 },
    });
    expect(kernel.handleServiceReq).toHaveBeenCalledTimes(1);

    await expect(kernel.serviceLinkedAdapterFrame({
      ...input,
      frame: {
        ...frame,
        args: {
          ...frame.args,
          message: {
            ...frame.args.message,
            actor: { id: "actor-2" },
          },
        },
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 401 } });
    expect(kernel.isMasterAdapterInboundAuthorized).toHaveBeenCalledTimes(2);
    expect(kernel.handleServiceReq).toHaveBeenCalledTimes(1);
  });
});

describe("Kernel live credential fencing", () => {
  it("persists an exact-token fence and defers only the response socket close", () => {
    const caller = {
      id: "caller",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: null },
      },
      close: vi.fn(),
    };
    const sibling = {
      id: "sibling",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: null },
      },
      close: vi.fn(),
    };
    const otherToken = {
      id: "other-token",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-b", expiresAt: null },
      },
      close: vi.fn(),
    };
    const password = {
      id: "password",
      state: { step: "connected", credential: { kind: "password" } },
      close: vi.fn(),
    };
    const rememberAll = vi.fn();
    const kernel = createKernel() as any;
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.tokenRevocations = { rememberAll };
    kernel.connections = new Map([
      [caller.id, caller],
      [sibling.id, sibling],
      [otherToken.id, otherToken],
      [password.id, password],
    ]);
    kernel.deferredCredentialClosures = new Set();

    kernel.persistAndFenceTokenRevocations([{
      tokenId: "token-a",
      uid: 1000,
      revokedAt: 10,
    }], caller.id);

    expect(rememberAll).toHaveBeenCalledBefore(sibling.close);
    expect(sibling.close).toHaveBeenCalledWith(1008, "Authentication expired");
    expect(caller.close).not.toHaveBeenCalled();
    expect(otherToken.close).not.toHaveBeenCalled();
    expect(password.close).not.toHaveBeenCalled();

    kernel.flushDeferredCredentialClosures();
    expect(caller.close).toHaveBeenCalledWith(1008, "Authentication expired");
  });

  it("fails closed for expired, tombstoned, and pre-upgrade connection state", () => {
    const kernel = createKernel() as any;
    kernel.tokenRevocations = {
      isRevoked: vi.fn((tokenId: string) => tokenId === "revoked-token"),
    };

    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "password" },
    })).toBe(true);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "future-token", expiresAt: Date.now() + 1_000 },
    })).toBe(true);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "expired-token", expiresAt: Date.now() - 1 },
    })).toBe(false);
    expect(kernel.isConnectionCredentialActive({
      step: "connected",
      credential: { kind: "token", tokenId: "revoked-token", expiresAt: null },
    })).toBe(false);
    expect(kernel.isConnectionCredentialActive({ step: "connected" })).toBe(false);
  });

  it("excludes provenance-less sockets while rebuilding hibernated connections", () => {
    const stale = {
      id: "stale",
      state: {
        step: "connected",
        identity: { role: "user", process: { uid: 1000 } },
      },
      close: vi.fn(),
    };
    const current = {
      id: "current",
      state: {
        step: "connected",
        identity: { role: "user", process: { uid: 1000 } },
        credential: { kind: "password" },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    kernel.getConnections = vi.fn(() => [stale, current]);
    kernel.connections = new Map();
    kernel.tokenRevocations = { isRevoked: vi.fn(() => false) };
    kernel.devices = { listOnline: vi.fn(() => []), setOnline: vi.fn() };
    kernel.broadcastDeviceStatus = vi.fn();

    kernel.rehydrateConnections();

    expect(stale.close).toHaveBeenCalledWith(1008, "Authentication expired");
    expect(kernel.connections.has(stale.id)).toBe(false);
    expect(kernel.connections.get(current.id)).toBe(current);
  });

  it("reauthorizes target tombstones against exact Master revocation state", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 4,
      })),
    };
    kernel.auth = {
      getToken: vi.fn(() => ({ tokenId: "token-a", uid: 1000, revokedAt: null })),
    };
    kernel.authorizeUserKernelCapability = vi.fn(async (proof: {
      generation: number;
      kernelCapability: string;
    }) => proof.generation === 4 && proof.kernelCapability === TEST_KERNEL_CAPABILITY
      ? kernel.userKernels.get("alice")
      : null);
    const input = {
      sourceKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      generation: 4,
      kernelCapability: TEST_KERNEL_CAPABILITY,
      notice: { tokenId: "token-a", uid: 1000, revokedAt: 10 },
    };

    await expect(kernel.confirmTokenRevocationDelivery(input)).resolves.toBe(false);
    kernel.auth.getToken.mockReturnValue({ tokenId: "token-a", uid: 1000, revokedAt: 10 });
    await expect(kernel.confirmTokenRevocationDelivery(input)).resolves.toBe(true);
    await expect(kernel.confirmTokenRevocationDelivery({
      ...input,
      generation: 3,
    })).resolves.toBe(false);
  });

  it("rejects a forged target delivery before persisting its tombstone", async () => {
    const confirmTokenRevocationDelivery = vi.fn(async () => false);
    const masterStub = {
      setName: vi.fn(async () => {}),
      confirmTokenRevocationDelivery,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => masterStub),
      },
    };
    kernel.loadUserKernelMarker = vi.fn(async () => ({
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
    }));
    kernel.requireLocalUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.tokenRevocations = { remember: vi.fn() };
    kernel.connections = new Map();
    const delivery = {
      sourceKernelName: "singleton",
      username: "alice",
      uid: 1000,
      generation: 4,
      notice: { tokenId: "still-active", uid: 1000, revokedAt: 10 },
    };

    await expect(kernel.receiveMasterTokenRevocation(delivery)).resolves.toBe(false);
    expect(confirmTokenRevocationDelivery).toHaveBeenCalledWith({
      sourceKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      generation: 4,
      kernelCapability: TEST_KERNEL_CAPABILITY,
      notice: delivery.notice,
    });
    expect(kernel.tokenRevocations.remember).not.toHaveBeenCalled();

    const close = vi.fn();
    kernel.connections = new Map([["connection-1", {
      id: "connection-1",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "still-active", expiresAt: null },
      },
      close,
    }]]);
    kernel.deferredCredentialClosures = new Set();
    confirmTokenRevocationDelivery.mockResolvedValueOnce(true);
    await expect(kernel.receiveMasterTokenRevocation(delivery)).resolves.toBe(true);
    expect(kernel.tokenRevocations.remember).toHaveBeenCalledBefore(close);
    expect(close).toHaveBeenCalledWith(1008, "Authentication expired");
  });

  it("acknowledges an outbox row only after delivery and retries failures", async () => {
    const record = {
      tokenId: "token-a",
      uid: 1000,
      revokedAt: 10,
      attemptCount: 0,
      nextAttemptAt: 10,
      lastError: null,
    };
    const kernel = createKernel() as any;
    kernel.tokenRevocations = {
      listDue: vi.fn(() => [record]),
      acknowledge: vi.fn(),
      recordFailure: vi.fn(),
      nextAttemptAt: vi.fn(() => null),
    };
    kernel.deliverTokenRevocation = vi.fn(async () => {});

    await kernel.deliverTokenRevocationOutbox();
    expect(kernel.deliverTokenRevocation).toHaveBeenCalledWith(record);
    expect(kernel.tokenRevocations.acknowledge).toHaveBeenCalledWith("token-a", 1000);
    expect(kernel.tokenRevocations.recordFailure).not.toHaveBeenCalled();

    kernel.tokenRevocations.acknowledge.mockClear();
    kernel.deliverTokenRevocation.mockRejectedValueOnce(new Error("target unavailable"));
    await kernel.deliverTokenRevocationOutbox();
    expect(kernel.tokenRevocations.acknowledge).not.toHaveBeenCalled();
    expect(kernel.tokenRevocations.recordFailure).toHaveBeenCalledWith(
      "token-a",
      expect.any(Error),
    );
  });

  it("closes an expired token through the scheduled object payload", async () => {
    const connection = {
      id: "connection-1",
      state: {
        step: "connected",
        credential: { kind: "token", tokenId: "token-a", expiresAt: Date.now() - 1 },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[connection.id, connection]]);

    await kernel.onConnectionCredentialExpired({
      connectionId: connection.id,
      tokenId: "token-a",
    });

    expect(connection.close).toHaveBeenCalledWith(1008, "Authentication expired");

    connection.close.mockClear();
    connection.state.credential.expiresAt = null;
    await kernel.onConnectionCredentialExpired({
      connectionId: connection.id,
      tokenId: "token-a",
    });
    expect(connection.close).not.toHaveBeenCalled();
  });
});

describe("Kernel repository metadata authority", () => {
  const aliceIdentity = {
    role: "user",
    process: {
      uid: 1000,
      gid: 1000,
      gids: [1000],
      username: "alice",
      home: "/home/alice",
      cwd: "/home/alice",
    },
    capabilities: ["repo.apply"],
  } as const;

  it("accepts metadata mutations only from the exact active owner shard generation", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 7,
      })),
    };
    kernel.resolveMasterSyscallIdentity = vi.fn(() => aliceIdentity);
    kernel.applyAuthorizedRepoMetadataMutation = vi.fn(() => ({ changed: true }));
    kernel.authorizeUserKernelCapability = vi.fn(async (proof: {
      sourceKernelName: string;
      uid: number;
      generation: number;
      kernelCapability: string;
    }) => proof.sourceKernelName === "user:alice"
        && proof.uid === 1000
        && proof.generation === 7
        && proof.kernelCapability === TEST_KERNEL_CAPABILITY
      ? kernel.userKernels.get("alice")
      : null);
    const input = {
      sourceKernelName: "user:alice",
      callerOwnerUid: 1000,
      generation: 7,
      kernelCapability: TEST_KERNEL_CAPABILITY,
      identity: aliceIdentity,
      mutation: {
        kind: "register",
        call: "repo.apply",
        repo: { owner: "alice", repo: "notes" },
      },
    };

    await expect(kernel.mutateUserRepoMetadata(input)).resolves.toEqual({ changed: true });
    expect(kernel.applyAuthorizedRepoMetadataMutation).toHaveBeenCalledWith(
      input.mutation,
      aliceIdentity,
      1000,
      expect.any(Function),
    );

    for (const forged of [
      { ...input, sourceKernelName: "user:bob" },
      { ...input, callerOwnerUid: 1001 },
      { ...input, generation: 6 },
    ]) {
      kernel.resolveMasterSyscallIdentity.mockClear();
      await expect(kernel.mutateUserRepoMetadata(forged)).rejects.toThrow(
        "Repository metadata authentication failed",
      );
      expect(kernel.resolveMasterSyscallIdentity).not.toHaveBeenCalled();
    }

    kernel.resolveMasterSyscallIdentity.mockReturnValueOnce(null);
    await expect(kernel.mutateUserRepoMetadata({
      ...input,
      identity: {
        ...aliceIdentity,
        process: { ...aliceIdentity.process, username: "root" },
      },
    })).rejects.toThrow("Repository metadata authentication failed");
  });

  it("reauthorizes the exact capability and repository owner before writing", async () => {
    const values = new Map<string, string>();
    const config = {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
      delete: (key: string) => values.delete(key),
    };
    const context = {
      identity: aliceIdentity,
      auth: {
        getPasswdByUid: vi.fn(() => null),
        getPasswdByUsername: vi.fn(() => null),
      },
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.config = config;
    kernel.ctx = { storage: { transactionSync: (closure: () => unknown) => closure() } };
    kernel.buildKernelContext = vi.fn(() => context);
    kernel.broadcastRepoProjection = vi.fn();

    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).resolves.toEqual({ changed: true });
    expect(values.has("repos/alice/notes/created_at")).toBe(true);
    expect(values.has("repos/alice/notes/updated_at")).toBe(true);
    expect(kernel.broadcastRepoProjection).toHaveBeenCalledOnce();

    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.import",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Permission denied: repo.import");
    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "register",
      call: "repo.apply",
      repo: { owner: "bob", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Forbidden: cannot write repo bob/notes");
    await expect(kernel.applyAuthorizedRepoMetadataMutation({
      kind: "delete",
      call: "repo.apply",
      repo: { owner: "alice", repo: "notes" },
    }, aliceIdentity, 1000)).rejects.toThrow("Invalid repository metadata mutation");
  });

  it("accepts projection invalidations only from the Master with a closed signal set", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.loadUserKernelMarker = vi.fn();

    await expect(kernel.receiveMasterProjection({
      sourceKernelName: "user:bob",
      generation: 1,
      signal: "pkg.changed",
    })).resolves.toBe(false);
    await expect(kernel.receiveMasterProjection({
      sourceKernelName: "singleton",
      generation: 1,
      signal: "identity.changed",
    })).resolves.toBe(false);
    expect(kernel.loadUserKernelMarker).not.toHaveBeenCalled();
  });
});

describe("Kernel frame bodies", () => {
  it("persists only a pseudonymous login source in hibernation state", async () => {
    const values = new Map<string, string>();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.config = {
      getExplicit: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => values.set(key, value),
    };
    const connection: any = {
      id: "source-connection",
      state: undefined,
      setState: vi.fn((state) => {
        connection.state = state;
      }),
    };

    await kernel.onConnect(connection, {
      request: new Request("https://gsv.test/ws", {
        headers: { "CF-Connecting-IP": "203.0.113.44" },
      }),
    });

    expect(connection.state).toMatchObject({
      step: "pending",
      loginSourceScope: expect.stringMatching(/^source:\d+:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(connection.state)).not.toContain("203.0.113.44");

    const persistedState = structuredClone(connection.state);
    kernel.buildKernelContext = vi.fn((options) => options);
    const context = kernel.buildContext({
      ...connection,
      state: persistedState,
    });
    expect(context.loginSourceScope).toBe(persistedState.loginSourceScope);
  });

  it("accepts only the edge-derived source scope in a user Kernel", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const connection: any = {
      state: undefined,
      setState: vi.fn((state) => {
        connection.state = state;
      }),
    };
    const scope = `source:123:${"a".repeat(64)}`;

    await kernel.onConnect(connection, {
      request: new Request("https://gsv.test/ws/alice", {
        headers: {
          "CF-Connecting-IP": "203.0.113.44",
          [USER_KERNEL_LOGIN_SOURCE_HEADER]: scope,
          [USER_KERNEL_GENERATION_HEADER]: "3",
        },
      }),
    });

    expect(connection.state).toEqual({
      step: "pending",
      loginSourceScope: scope,
      kernelGeneration: 3,
    });
    expect(JSON.stringify(connection.state)).not.toContain("203.0.113.44");
  });

  it("passes request cancellation to Agents SDK MCP calls", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.ctx = {
      storage: { transactionSync: (closure: () => unknown) => closure() },
    };
    kernel.mcp = { callTool };
    const controller = new AbortController();
    const ctx = kernel.buildKernelContext({ requestSignal: controller.signal });

    expect(ctx.kernelName).toBe("singleton");
    await ctx.callMcpTool("server-1", "lookup", { query: "gsv" }, ctx.requestSignal);

    expect(callTool).toHaveBeenCalledWith(
      {
        serverId: "server-1",
        name: "lookup",
        arguments: { query: "gsv" },
      },
      undefined,
      { signal: controller.signal },
    );
  });

  it("decodes WebSocket body frames into a byte stream", async () => {
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    const connection = { id: "conn-1", send: vi.fn() };

    const frame = kernel.decodeWebSocketFrame(connection, {
      type: "req",
      id: "req-1",
      call: "fs.transfer.receive",
      args: { path: "/tmp/file" },
      body: { streamId: 7, length: 3 },
    });
    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(7, BINARY_FRAME_DATA, new Uint8Array([1, 2, 3])),
    );
    kernel.handleBinaryMessage(connection, buildBinaryFrame(7, BINARY_FRAME_END));

    expect(frame.body.length).toBe(3);
    expect(
      new Uint8Array(await new Response(frame.body.stream).arrayBuffer()),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(kernel.frameBodyChannels.get(connection.id).pending.size).toBe(0);
  });

  it("announces a response body before sending its chunks", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const pending: Promise<unknown>[] = [];
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const connection = {
      id: "connection-1",
      send: (message: string | ArrayBuffer) => sends.push(message),
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });

    kernel.sendWebSocketFrame(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { ok: true },
      body: { stream, length: 3 },
    });
    await Promise.all(pending);

    const descriptor = JSON.parse(sends[0] as string);
    const data = parseBinaryFrame(sends[1] as ArrayBuffer);
    const end = parseBinaryFrame(sends[2] as ArrayBuffer);
    expect(descriptor.body).toEqual({ streamId: 1, length: 3 });
    expect(data).toMatchObject({ streamId: descriptor.body.streamId, flags: BINARY_FRAME_DATA });
    expect(data?.payload).toEqual(new Uint8Array([4, 5, 6]));
    expect(end).toMatchObject({ flags: BINARY_FRAME_END });
  });

  it("cancels an unfinished request body when a device responds early", async () => {
    const kernel = createKernel() as any;
    kernel.pendingAppResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "device-1" },
      },
    };
    kernel.connections = new Map([[deviceConnection.id, deviceConnection]]);
    kernel.findDeviceConnection = () => deviceConnection;
    kernel.registerRouteWithExpiry = vi.fn(async () => ({ cancel: vi.fn() }));
    const outgoing = { cancel: vi.fn(async () => {}) };
    kernel.sendWebSocketFrame = vi.fn((_connection: unknown, frame: { id: string }) => {
      queueMicrotask(() => kernel.pendingAppResponses.get(frame.id)?.({
        type: "res",
        id: frame.id,
        ok: true,
        data: { ok: true },
      }));
      return outgoing;
    });

    await kernel.requestDevice("device-1", "net.fetch", {}, {
      body: { stream: new ReadableStream(), length: 1 },
    });

    expect(outgoing.cancel).toHaveBeenCalledWith("Device request completed");
  });

  it("cancels a request body when device routing fails before send", async () => {
    const cancel = vi.fn();
    const kernel = createKernel() as any;
    kernel.devices = { get: () => null };

    await expect(kernel.requestDevice("offline-device", "fs.transfer.receive", {}, {
      body: {
        stream: new ReadableStream({ cancel }),
        length: 1,
      },
    })).rejects.toThrow("Device offline: offline-device");

    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      message: "Device offline: offline-device",
    }));
  });

  it("cancels the route and upload when a device request is aborted", async () => {
    const kernel = createKernel() as any;
    kernel.pendingAppResponses = new Map();
    kernel.devices = {
      get: () => ({ online: true }),
      canHandle: () => true,
    };
    const deviceConnection = {
      id: "device-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "device-1" },
      },
    };
    kernel.connections = new Map([[deviceConnection.id, deviceConnection]]);
    kernel.findDeviceConnection = () => deviceConnection;
    const cancelRoute = vi.fn();
    kernel.registerRouteWithExpiry = vi.fn(async () => ({ cancel: cancelRoute }));
    const outgoing = { cancel: vi.fn(async () => {}) };
    kernel.sendWebSocketFrame = vi.fn(() => outgoing);
    const controller = new AbortController();
    const reason = new Error("caller stopped");

    const request = kernel.requestDevice("device-1", "net.fetch", {}, {
      body: { stream: new ReadableStream(), length: 1 },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(kernel.sendWebSocketFrame).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(cancelRoute).toHaveBeenCalledOnce();
    expect(outgoing.cancel).toHaveBeenCalledWith(reason);
    expect(kernel.sendWebSocketFrame).toHaveBeenLastCalledWith(
      deviceConnection,
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: expect.any(String), reason: "caller stopped" },
      },
    );
  });

  it("cancels announced bodies on requests rejected before dispatch", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.auth = { isSetupMode: () => false };
    kernel.config = { get: () => null };
    const connection = {
      id: "pending-connection",
      state: { step: "pending" },
      send: (message: string | ArrayBuffer) => sends.push(message),
    };

    await kernel.handleReq(connection, {
      type: "req",
      id: "denied-request",
      call: "fs.transfer.receive",
      args: { path: "/tmp/file" },
      body: { streamId: 12, length: 1 },
    });

    expect(JSON.parse(sends[0] as string)).toMatchObject({
      type: "res",
      id: "denied-request",
      ok: false,
      error: { code: 403 },
    });
    expect(parseBinaryFrame(sends[1] as ArrayBuffer)).toMatchObject({
      streamId: 12,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("rejects bodies that do not match their declared length", async () => {
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    const connection = { id: "conn-1", send: vi.fn() };
    const body = kernel.receiveFrameBody(connection, { streamId: 8, length: 3 });

    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(8, BINARY_FRAME_DATA, new Uint8Array([1, 2])),
    );
    kernel.handleBinaryMessage(connection, buildBinaryFrame(8, BINARY_FRAME_END));

    await expect(new Response(body.stream).arrayBuffer()).rejects.toThrow(
      "Body length 2 did not match 3",
    );
    expect(kernel.frameBodyChannels.get(connection.id).pending.size).toBe(0);
  });

  it("does not register bodies from an invalid response route", () => {
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = {
      get: () => ({ deviceId: "expected-device", driverConnectionId: null }),
    };
    kernel.isConnectionForDevice = vi.fn(() => false);

    kernel.handleRes({ id: "wrong-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { streamId: 9, length: 3 },
    });

    expect(kernel.frameBodyChannels.size).toBe(0);
  });

  it("rejects a response from a different connection for the same device", () => {
    const route = {
      deviceId: "device-1",
      driverConnectionId: "current-connection",
      origin: { type: "app", id: "req-1" },
      call: "fs.read",
      scheduleId: null,
    };
    const kernel = createKernel() as any;
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(),
    };
    kernel.isConnectionForDevice = vi.fn(() => true);
    kernel.decodeWebSocketFrame = vi.fn();

    kernel.handleRes({ id: "stale-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "stale" },
    });

    expect(kernel.decodeWebSocketFrame).not.toHaveBeenCalled();
    expect(kernel.routes.remove).not.toHaveBeenCalled();
  });

  it("accepts an authoritative response for a route created before connection binding", () => {
    const route = {
      deviceId: "device-1",
      driverConnectionId: null,
      origin: { type: "app", id: "req-1" },
      call: "fs.read",
      scheduleId: null,
    };
    const kernel = createKernel() as any;
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(() => route),
    };
    kernel.routedBodies = new Map();
    kernel.isConnectionForDevice = vi.fn(() => true);
    kernel.decodeWebSocketFrame = vi.fn((_connection: unknown, frame: unknown) => frame);
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "current-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "current" },
    });

    expect(kernel.routes.remove).toHaveBeenCalledWith("req-1");
    expect(kernel.deliverToOrigin).toHaveBeenCalledWith(route.origin, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { content: "current" },
    });
  });

  it("fails a routed caller immediately when the response body descriptor is invalid", () => {
    const cancelBody = vi.fn(async () => {});
    const route = {
      deviceId: "device-1",
      driverConnectionId: "device-connection",
      origin: { type: "app", id: "req-1" },
      call: "net.fetch",
      scheduleId: "schedule-1",
    };
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = {
      get: vi.fn(() => route),
      remove: vi.fn(() => route),
    };
    kernel.routedBodies = new Map([["req-1", { cancel: cancelBody }]]);
    kernel.isConnectionForDevice = () => true;
    kernel.cancelSchedule = vi.fn(async () => {});
    kernel.deliverToOrigin = vi.fn();
    const connection = { id: "device-connection", send: vi.fn() };

    kernel.handleRes(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { streamId: 0, length: 3 },
    });

    expect(kernel.routes.remove).toHaveBeenCalledWith("req-1");
    expect(kernel.cancelSchedule).toHaveBeenCalledWith("schedule-1");
    expect(cancelBody).toHaveBeenCalledWith("Route cancelled");
    expect(kernel.routedBodies.size).toBe(0);
    expect(kernel.deliverToOrigin).toHaveBeenCalledWith(route.origin, {
      type: "res",
      id: "req-1",
      ok: false,
      error: {
        code: 502,
        message: "Invalid response from device device-1: Invalid binary stream id: 0",
      },
    });
    expect(JSON.parse(connection.send.mock.calls[0][0])).toEqual({
      type: "res",
      id: "req-1",
      ok: false,
      error: { code: 400, message: "Invalid binary stream id: 0" },
    });
  });

  it("cancels a response body that arrives after its route is gone", async () => {
    const sends: ArrayBuffer[] = [];
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.routes = { get: () => null };
    const connection = {
      id: "conn-late",
      send: (message: ArrayBuffer) => sends.push(message),
    };

    kernel.handleRes(connection, {
      type: "res",
      id: "late-response",
      ok: true,
      body: { streamId: 9, length: 3 },
    });

    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(parseBinaryFrame(sends[0])).toMatchObject({
      streamId: 9,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("stops a routed upload when the device response arrives", async () => {
    const cancel = vi.fn(async () => {});
    const route = {
      deviceId: "device-1",
      driverConnectionId: "device-connection",
      origin: { type: "app", id: "req-1" },
      call: "net.fetch",
      scheduleId: null,
    };
    const kernel = createKernel() as any;
    kernel.routes = {
      get: () => route,
      remove: () => route,
    };
    kernel.routedBodies = new Map([["req-1", { cancel }]]);
    kernel.isConnectionForDevice = () => true;
    kernel.decodeWebSocketFrame = (_connection: unknown, frame: unknown) => frame;
    kernel.deliverToOrigin = vi.fn();

    kernel.handleRes({ id: "device-connection" }, {
      type: "res",
      id: "req-1",
      ok: true,
      data: { ok: true },
    });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Device response received"));
    expect(kernel.routedBodies.size).toBe(0);
  });

  it("sends a cancellation frame when an inbound body is discarded", async () => {
    const sends: ArrayBuffer[] = [];
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    const connection = {
      id: "conn-1",
      send: (message: ArrayBuffer) => sends.push(message),
    };
    const body = kernel.receiveFrameBody(connection, { streamId: 10 });

    await body.stream.cancel("body ignored");

    expect(parseBinaryFrame(sends[0])).toMatchObject({
      streamId: 10,
      flags: BINARY_FRAME_CANCEL | BINARY_FRAME_END,
    });
  });

  it("cancels an outgoing body pump when the receiver sends cancellation", async () => {
    const sends: Array<string | ArrayBuffer> = [];
    const pending: Promise<unknown>[] = [];
    let cancelled = false;
    const kernel = createKernel() as any;
    kernel.frameBodyChannels = new Map();
    kernel.ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    const connection = {
      id: "connection-1",
      send: (message: string | ArrayBuffer) => sends.push(message),
    };
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });

    kernel.sendWebSocketFrame(connection, {
      type: "res",
      id: "req-1",
      ok: true,
      body: { stream },
    });
    const descriptor = JSON.parse(sends[0] as string);
    kernel.handleBinaryMessage(
      connection,
      buildBinaryFrame(descriptor.body.streamId, BINARY_FRAME_CANCEL | BINARY_FRAME_END),
    );
    await Promise.all(pending);

    expect(cancelled).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it("cancels a request body forwarded to a process", async () => {
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let forwardedError: unknown;
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => {
      const reader = frame.body!.stream.getReader();
      reading();
      try {
        await reader.read();
      } catch (error) {
        forwardedError = error;
        throw error;
      } finally {
        reader.releaseLock();
      }
      return null;
    });
    let sourceCancellation: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel(reason) {
        sourceCancellation = reason;
      },
    }, { highWaterMark: 0 });
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: () => null };
    kernel.buildProcessContext = () => ({
      callerOwnerUid: 0,
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
      procs: {
        get: () => ({ ownerUid: 0 }),
      },
      conversations: {
        getByActivePid: () => null,
      },
    });
    kernel.buildDispatchDeps = () => ({});
    kernel.applyPostDispatchEffects = vi.fn();
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
    kernel.procs = {
      get: vi.fn(() => ({
        ownerUid: 0,
        kernelGeneration: null,
        packageSecurityRevision: null,
      })),
    };
    const request = kernel.handleProcessReq("source-process", {
      type: "req",
      id: "media-upload",
      call: "proc.media.write",
      args: {
        pid: "target-process",
        type: "image",
        mimeType: "image/png",
      },
      body: { stream: body, length: 1 },
    });
    await Promise.race([
      readStarted,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("forwarded body was not read")), 500);
      }),
    ]);

    expect(await kernel.cancelProcessRequests(
      "source-process",
      ["media-upload"],
      "User interrupted upload",
    )).toBe(1);

    await expect(Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("forwarded body did not cancel")), 500);
      }),
    ])).resolves.toMatchObject({
      ok: false,
      error: { message: "User interrupted upload" },
    });
    expect(forwardedError).toEqual(new Error("User interrupted upload"));
    expect(sourceCancellation).toEqual(new Error("User interrupted upload"));

    let ignoredCancellation: unknown;
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "ignored-upload",
      ok: true,
      data: { ok: true },
    });
    await kernel.recvFrame("source-process", {
      type: "req",
      id: "ignored-upload",
      call: "proc.media.write",
      args: {
        pid: "target-process",
        type: "image",
        mimeType: "image/png",
      },
      body: {
        stream: new ReadableStream<Uint8Array>({
          cancel(reason) {
            ignoredCancellation = reason;
          },
        }),
        length: 1,
      },
    });

    expect(ignoredCancellation).toBe("Process request completed");
  });
});

describe("Kernel nested dispatch", () => {
  it("cancels request bodies rejected by nested capability checks", async () => {
    let cancelled: unknown;
    const kernel = createKernel() as any;
    const response = await kernel.requestDispatchedFrame(
      {
        type: "req",
        id: "nested-denied",
        call: "net.fetch",
        args: { url: "https://example.com" },
        body: {
          stream: new ReadableStream({
            cancel(reason) {
              cancelled = reason;
            },
          }),
          length: 1,
        },
      },
      { identity: { capabilities: [] } },
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 403, message: "Permission denied: net.fetch" },
    });
    expect(cancelled).toBe("Dispatched request rejected");
  });

  it("forwards cancellation for an awaited nested device request", async () => {
    const controller = new AbortController();
    const reason = new Error("new user message");
    const driver = {
      id: "driver-connection",
      state: {
        step: "connected",
        identity: {
          role: "driver",
          device: "workstation",
        },
      },
    };
    let route: any = null;
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.pendingAppResponses = new Map();
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.connections = new Map([[driver.id, driver]]);
    kernel.shellSessions = { get: vi.fn() };
    kernel.routedBodies = new Map();
    kernel.routes = {
      get: vi.fn((id: string) => route?.id === id ? route : null),
      remove: vi.fn((id: string) => {
        if (route?.id !== id) return null;
        const removed = {
          origin: route.origin,
          call: route.call,
          deviceId: route.deviceId,
          driverConnectionId: route.driverConnectionId,
          scheduleId: null,
        };
        route = null;
        return removed;
      }),
    };
    kernel.cancelSchedule = vi.fn(async () => {});
    kernel.registerRouteWithExpiry = vi.fn(async (input: any) => {
      route = { ...input, scheduleId: null };
      return {
        cancel: () => kernel.cancelRoute(input.id),
        attachBody: vi.fn(),
      };
    });
    kernel.sendWebSocketFrame = vi.fn(() => null);
    kernel.requestDevice = vi.fn();
    const ctx = {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["shell.exec"],
      },
      devices: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => ({
          device_id: "workstation",
          owner_uid: 1000,
          label: "Workstation",
          description: "",
          implements: ["shell.exec"],
          platform: "linux",
          version: "test",
          online: true,
          first_seen_at: 1,
          last_seen_at: 2,
          connected_at: 2,
          disconnected_at: null,
        })),
      },
      auth: { getPasswdByUid: vi.fn(() => null) },
    };
    const request = kernel.requestDispatchedFrame(
      {
        type: "req",
        id: "nested-shell",
        call: "shell.exec",
        args: { target: "workstation", input: "sleep 300" },
      },
      ctx,
      controller.signal,
    );

    await vi.waitFor(() => expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(
      driver,
      {
        type: "req",
        id: "nested-shell",
        call: "shell.exec",
        args: { input: "sleep 300" },
      },
    ));
    expect(kernel.activeRequests.size).toBe(0);
    controller.abort(reason);

    await expect(request).rejects.toThrow("new user message");
    expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(
      driver,
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: "nested-shell", reason: "new user message" },
      },
    );
    expect(route).toBeNull();
  });
});

describe("Kernel device connection cleanup", () => {
  it("makes a replacement authoritative before closing the old connection", () => {
    const identity = {
      role: "driver",
      process: { uid: 1000 },
      device: "browser",
    };
    const oldConnection: any = {
      id: "old-connection",
      state: {
        step: "connected",
        identity,
        clientId: "browser",
      },
      setState: vi.fn((state) => {
        oldConnection.state = state;
      }),
      close: vi.fn(),
    };
    const replacement: any = {
      id: "new-connection",
      state: { step: "pending" },
      setState: vi.fn((state) => {
        replacement.state = state;
      }),
      close: vi.fn(),
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[oldConnection.id, oldConnection]]);

    kernel.activateConnection(replacement, {
      step: "connected",
      identity,
      clientId: "browser",
    });

    expect(kernel.connections.get(replacement.id)).toBe(replacement);
    expect(kernel.connections.has(oldConnection.id)).toBe(false);
    expect(oldConnection.state.step).toBe("superseded");
    expect(oldConnection.close).toHaveBeenCalledWith(1000, "Replaced by newer connection");
    expect(replacement.setState.mock.invocationCallOrder[0])
      .toBeLessThan(oldConnection.close.mock.invocationCallOrder[0]);
  });

  it("does not let a superseded close disconnect its replacement", () => {
    const oldConnection = {
      id: "old-connection",
      state: {
        step: "superseded",
        identity: { role: "driver", device: "browser" },
      },
    };
    const replacement = {
      id: "new-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "browser" },
      },
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[replacement.id, replacement]]);
    kernel.activeRequests = new Map();
    kernel.closeFrameBodyChannel = vi.fn();
    kernel.devices = { setOnline: vi.fn() };
    kernel.broadcastDeviceStatus = vi.fn();
    kernel.failRoutesForDevice = vi.fn();
    kernel.failRoutesForDriverConnection = vi.fn();
    kernel.failRoutesForConnection = vi.fn();
    kernel.runRoutes = { clearForConnection: vi.fn() };

    kernel.onClose(oldConnection);

    expect(kernel.connections.get(replacement.id)).toBe(replacement);
    expect(kernel.devices.setOnline).not.toHaveBeenCalled();
    expect(kernel.broadcastDeviceStatus).not.toHaveBeenCalled();
    expect(kernel.failRoutesForDevice).not.toHaveBeenCalled();
    expect(kernel.failRoutesForDriverConnection).toHaveBeenCalledWith(oldConnection.id);
  });

  it("replies to an authoritative driver ping on the same connection", () => {
    const connection = {
      id: "driver-connection",
      state: {
        step: "connected",
        identity: { role: "driver", device: "browser" },
      },
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[connection.id, connection]]);
    kernel.sendWebSocketFrame = vi.fn();

    kernel.handleSig(connection, {
      type: "sig",
      signal: "device.ping",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });

    expect(kernel.sendWebSocketFrame).toHaveBeenCalledWith(connection, {
      type: "sig",
      signal: "device.pong",
      payload: { at: 1234, nonce: "ping-1" },
      seq: 7,
    });
  });

  it("aborts native requests when their origin disconnects", () => {
    const controller = new AbortController();
    const connection = {
      id: "connection-1",
      state: { step: "connected", identity: { role: "user" } },
    };
    const kernel = createKernel() as any;
    kernel.connections = new Map([[connection.id, connection]]);
    kernel.activeRequests = new Map([
      ["request-1", {
        origin: { type: "connection", id: connection.id },
        controller,
      }],
    ]);
    kernel.routes = { get: vi.fn(() => null) };
    kernel.closeFrameBodyChannel = vi.fn();
    kernel.failRoutesForConnection = vi.fn();
    kernel.runRoutes = { clearForConnection: vi.fn() };

    kernel.onClose(connection);

    expect(controller.signal.reason).toEqual(new Error("Origin disconnected"));
    expect(kernel.failRoutesForConnection).toHaveBeenCalledWith(connection.id);
  });

  it("closes live driver connections when a machine is forgotten", () => {
    const alpha = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-alpha" },
      },
      close: vi.fn(),
    };
    const beta = {
      state: {
        step: "connected",
        identity: { role: "driver", device: "node-beta" },
      },
      close: vi.fn(),
    };
    const user = {
      state: {
        step: "connected",
        identity: { role: "user" },
      },
      close: vi.fn(),
    };
    const kernel = createKernel() as {
      connections: Map<string, unknown>;
      disconnectDeviceConnections(deviceId: string, reason: string): void;
      failRoutesForDevice: ReturnType<typeof vi.fn>;
      runRoutes: {
        clearForConnection: ReturnType<typeof vi.fn>;
      };
    };
    kernel.connections = new Map([
      ["alpha", alpha],
      ["beta", beta],
      ["user", user],
    ]);
    kernel.failRoutesForDevice = vi.fn();
    kernel.runRoutes = {
      clearForConnection: vi.fn(),
    };

    kernel.disconnectDeviceConnections("node-alpha", "Machine forgotten");

    expect(alpha.close).toHaveBeenCalledWith(1000, "Machine forgotten");
    expect(beta.close).not.toHaveBeenCalled();
    expect(user.close).not.toHaveBeenCalled();
    expect(kernel.connections.has("alpha")).toBe(false);
    expect(kernel.connections.has("beta")).toBe(true);
    expect(kernel.connections.has("user")).toBe(true);
    expect(kernel.runRoutes.clearForConnection).toHaveBeenCalledWith("alpha");
    expect(kernel.failRoutesForDevice).toHaveBeenCalledWith("node-alpha");
  });
});

describe("Kernel user signal broadcasts", () => {
  it("does not send user signals to driver or service sockets", () => {
    const user = { state: { identity: { role: "user", process: { uid: 1000 } } }, send: vi.fn() };
    const otherUser = { state: { identity: { role: "user", process: { uid: 2000 } } }, send: vi.fn() };
    const driver = { state: { identity: { role: "driver", process: { uid: 1000 } } }, send: vi.fn() };
    const service = { state: { identity: { role: "service", process: { uid: 1000 } } }, send: vi.fn() };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.connections = new Map([
      ["user", user],
      ["other-user", otherUser],
      ["driver", driver],
      ["service", service],
    ]);

    kernel.broadcastToUserUid(1000, "notification.created", { id: "note-1" });

    expect(user.send).toHaveBeenCalledWith(JSON.stringify({
      type: "sig",
      signal: "notification.created",
      payload: { id: "note-1" },
    }));
    expect(otherUser.send).not.toHaveBeenCalled();
    expect(driver.send).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it("consumes an exact Master signal authorization only once", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.masterUserSignalAuthorizations = new Map();
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 4,
      })),
    };
    const input = {
      authorization: "signal-authorization",
      targetKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      generation: 4,
      signal: "notification.created",
      payloadJson: JSON.stringify({ id: "note-1" }),
    };
    kernel.masterUserSignalAuthorizations.set(input.authorization, {
      expiresAt: Date.now() + 10_000,
      signal: {
        targetKernelName: input.targetKernelName,
        username: input.username,
        uid: input.uid,
        generation: input.generation,
        signal: input.signal,
        payloadJson: input.payloadJson,
      },
    });

    await expect(kernel.consumeMasterUserSignalAuthorization({
      ...input,
      payloadJson: JSON.stringify({ id: "tampered" }),
    })).resolves.toBe(false);
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(false);

    kernel.masterUserSignalAuthorizations.set(input.authorization, {
      expiresAt: Date.now() + 10_000,
      signal: {
        targetKernelName: input.targetKernelName,
        username: input.username,
        uid: input.uid,
        generation: input.generation,
        signal: input.signal,
        payloadJson: input.payloadJson,
      },
    });
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(true);
    await expect(kernel.consumeMasterUserSignalAuthorization(input)).resolves.toBe(false);
  });

  it("broadcasts a Master signal only after its target consumes the one-shot", async () => {
    const consumeMasterUserSignalAuthorization = vi.fn(async () => true);
    const master = {
      setName: vi.fn(async () => undefined),
      consumeMasterUserSignalAuthorization,
    };
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => master),
      },
    };
    kernel.userKernelMarker = marker;
    kernel.broadcastToUserUid = vi.fn();
    const input = {
      sourceKernelName: "singleton",
      authorization: "signal-authorization",
      username: "alice",
      uid: 1000,
      generation: 4,
      signal: "notification.created",
      payloadJson: JSON.stringify({ id: "note-1" }),
    };

    await expect(kernel.receiveMasterUserSignal(input)).resolves.toBe(true);
    expect(consumeMasterUserSignalAuthorization).toHaveBeenCalledWith({
      authorization: input.authorization,
      targetKernelName: "user:alice",
      username: "alice",
      uid: 1000,
      generation: 4,
      signal: input.signal,
      payloadJson: input.payloadJson,
    });
    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(
      1000,
      input.signal,
      { id: "note-1" },
    );
  });
});

describe("Kernel process signal routing", () => {
  function buildKernel(route: Record<string, unknown>) {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.dispatchSignalWatches = vi.fn(async () => {});
    kernel.runRoutes = { get: vi.fn(() => route), delete: vi.fn() };
    kernel.broadcastToUserUid = vi.fn();
    kernel.deliverSignalToConnection = vi.fn();
    kernel.deliverSignalToAdapter = vi.fn(async () => {});
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
    return kernel;
  }

  const connectionRoute = {
    kind: "connection",
    runId: "run-1",
    uid: 1000,
    connectionId: "connection-1",
  };

  it("broadcasts connection-routed HIL requests without duplicating the origin", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToConnection).not.toHaveBeenCalled();
    expect(kernel.deliverSignalToAdapter).not.toHaveBeenCalled();
  });

  it("broadcasts adapter-routed HIL requests and preserves adapter delivery", async () => {
    const route = {
      kind: "adapter",
      runId: "run-1",
      uid: 1000,
      adapter: "discord",
      accountId: "account-1",
      surfaceKind: "dm",
      surfaceId: "surface-1",
    };
    const kernel = buildKernel(route);
    const frame = {
      type: "sig",
      signal: "proc.run.hil.requested",
      payload: { pid: "proc-1", runId: "run-1", requestId: "hil-1" },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).toHaveBeenCalledWith(1000, frame.signal, frame.payload);
    expect(kernel.deliverSignalToAdapter).toHaveBeenCalledWith(route, frame);
  });

  it("keeps ordinary run signals exclusive to their connection route", async () => {
    const kernel = buildKernel(connectionRoute);
    const frame = {
      type: "sig",
      signal: "proc.run.stream",
      payload: { pid: "proc-1", runId: "run-1", event: { type: "text_delta", delta: "hi" } },
    };

    await kernel.handleProcessSignal("proc-1", frame);

    expect(kernel.broadcastToUserUid).not.toHaveBeenCalled();
    expect(kernel.deliverSignalToConnection).toHaveBeenCalledWith(connectionRoute, frame, 1000);
  });
});

describe("Kernel adapter run route revocation", () => {
  const activeLink = {
    adapter: "discord",
    accountId: "primary",
    actorId: "actor-1",
    uid: 1000,
    generation: 3,
    createdAt: 1,
    linkedByUid: 0,
    metadata: null,
  };

  it("authorizes only the active user Kernel and exact current link generation", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = {
      get: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 7,
      })),
    };
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => activeLink),
        isCurrentGeneration: vi.fn((
          _adapter: string,
          _accountId: string,
          _actorId: string,
          generation: number,
        ) => generation === activeLink.generation),
      },
    };
    kernel.authorizeUserKernelCapability = vi.fn(async (proof: {
      generation: number;
      kernelCapability: string;
    }) => proof.generation === 7 && proof.kernelCapability === TEST_KERNEL_CAPABILITY
      ? kernel.userKernels.get("alice")
      : null);
    const input = {
      sourceKernelName: "user:alice",
      ownerUid: 1000,
      kernelGeneration: 7,
      kernelCapability: TEST_KERNEL_CAPABILITY,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 3,
    };

    await expect(kernel.authorizeAdapterRunRoute(input)).resolves.toBe(true);
    await expect(kernel.authorizeAdapterRunRoute({
      ...input,
      linkGeneration: 1,
    })).resolves.toBe(false);
    await expect(kernel.authorizeAdapterRunRoute({
      ...input,
      kernelGeneration: 6,
    })).resolves.toBe(false);

    kernel.adapters.identityLinks.get.mockReturnValue(null);
    await expect(kernel.authorizeAdapterRunRoute(input)).resolves.toBe(false);
  });

  it("deletes a stale route without adapter delivery and accepts the exact generation", async () => {
    const adapterSend = vi.fn(async () => ({ ok: true }));
    const adapterSetActivity = vi.fn(async () => ({ ok: true }));
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.env = {
      CHANNEL_DISCORD: {
        adapterSend,
        adapterSetActivity,
      },
    };
    kernel.adapters = {
      identityLinks: {
        get: vi.fn(() => activeLink),
        isCurrentGeneration: vi.fn((
          _adapter: string,
          _accountId: string,
          _actorId: string,
          generation: number,
        ) => generation === activeLink.generation),
      },
    };
    kernel.userKernels = {
      getByUid: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        lifecycle: "legacy",
        generation: 1,
      })),
    };
    kernel.runRoutes = { delete: vi.fn() };
    const route = {
      kind: "adapter",
      runId: "run-stale",
      uid: 1000,
      adapter: "discord",
      accountId: "primary",
      actorId: "actor-1",
      linkGeneration: 1,
      surfaceKind: "dm",
      surfaceId: "surface-1",
      createdAt: 1,
      expiresAt: 10_000,
    };
    const frame = {
      type: "sig",
      signal: "proc.run.finished",
      payload: { text: "finished" },
    };

    await kernel.deliverSignalToAdapter(route, frame);

    expect(kernel.runRoutes.delete).toHaveBeenCalledWith("run-stale");
    expect(adapterSend).not.toHaveBeenCalled();
    expect(adapterSetActivity).not.toHaveBeenCalled();

    const currentRoute = {
      ...route,
      runId: "run-current",
      linkGeneration: activeLink.generation,
    };
    await kernel.deliverSignalToAdapter(currentRoute, frame);

    expect(kernel.runRoutes.delete).toHaveBeenCalledTimes(1);
    expect(adapterSend).toHaveBeenCalledWith("primary", {
      surface: { kind: "dm", id: "surface-1", threadId: undefined },
      text: "finished",
    });
    expect(adapterSetActivity).toHaveBeenCalledWith(
      "primary",
      { kind: "dm", id: "surface-1", threadId: undefined },
      { kind: "typing", active: false },
    );
  });
});

describe("Kernel package invalidations", () => {
  it("refreshes the caller and broadcasts convergence even when a package handler errors", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    const identity = {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
      },
      capabilities: ["pkg.install"],
    };
    kernel.config = { get: vi.fn(() => null) };
    kernel.buildKernelContext = vi.fn(() => ({
      identity,
      callerOwnerUid: 1000,
      packages: {
        resolve: vi.fn(() => null),
        list: vi.fn(() => []),
      },
    }));
    kernel.buildDispatchDeps = vi.fn(() => ({}));
    kernel.broadcastPackageProjection = vi.fn();
    kernel.broadcastRepoProjection = vi.fn();
    kernel.tokenRevocationsFromResponse = vi.fn(() => []);

    const result = await kernel.dispatchAuthorizedMasterSyscall(
      {
        callerOwnerUid: 1000,
        frame: {
          type: "req",
          id: "failed-install",
          call: "pkg.install",
          args: { packageId: "missing" },
        },
      },
      "alice",
      { username: "alice", uid: 1000, generation: 4 },
      identity,
    );

    expect(result).toMatchObject({
      response: {
        type: "res",
        id: "failed-install",
        ok: false,
        error: { message: "Unknown package: missing" },
      },
      refreshProjection: true,
    });
    expect(kernel.broadcastPackageProjection).toHaveBeenCalledWith();
  });

  it("globally invalidates authoritative projections after a failed package mutation", () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.broadcastPackageProjection = vi.fn();
    kernel.broadcastRepoProjection = vi.fn();
    const failure = {
      type: "res",
      id: "failed-mutation",
      ok: false,
      error: { code: 500, message: "principal reconciliation failed" },
    };

    for (const call of [
      "sys.bootstrap",
      "pkg.add",
      "pkg.create",
      "pkg.sync",
      "pkg.checkout",
      "pkg.install",
      "pkg.review.approve",
      "pkg.remove",
      "pkg.public.set",
    ]) {
      kernel.broadcastPackageProjection.mockClear();
      kernel.applyFailedMasterMutationProjectionEffects(
        { type: "req", id: "failed-mutation", call, args: {} },
        failure,
      );
      expect(kernel.broadcastPackageProjection, call).toHaveBeenCalledWith();
    }

    expect(kernel.broadcastRepoProjection).toHaveBeenCalledTimes(2);
    kernel.broadcastPackageProjection.mockClear();
    kernel.applyFailedMasterMutationProjectionEffects(
      { type: "req", id: "remote-failure", call: "pkg.remote.add", args: {} },
      failure,
    );
    expect(kernel.broadcastPackageProjection).not.toHaveBeenCalled();
  });

  it("broadcasts every package security mutation within its package scope", () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.broadcastPackageProjection = vi.fn();
    kernel.broadcastRepoProjection = vi.fn();
    kernel.broadcastConfigProjection = vi.fn();

    for (const call of [
      "pkg.add",
      "pkg.create",
      "pkg.checkout",
      "pkg.install",
      "pkg.review.approve",
      "pkg.remove",
    ]) {
      kernel.broadcastPackageProjection.mockClear();
      kernel.applyPostDispatchEffects(
        { call, args: {} },
        { ok: true, data: { package: { scope: { kind: "user", uid: 1000 } } } },
      );
      expect(kernel.broadcastPackageProjection, call).toHaveBeenCalledWith(1000);
    }

    kernel.broadcastPackageProjection.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "pkg.sync", args: {} },
      { ok: true, data: { packages: [{ scope: { kind: "global" } }] } },
    );
    expect(kernel.broadcastPackageProjection).toHaveBeenCalledWith();

    kernel.broadcastPackageProjection.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "sys.bootstrap", args: {} },
      { ok: true, data: { packages: [] } },
    );
    expect(kernel.broadcastPackageProjection).toHaveBeenCalledWith();

    kernel.broadcastPackageProjection.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "pkg.remove", args: {} },
      { ok: true, data: { package: {} } },
    );
    expect(kernel.broadcastPackageProjection).not.toHaveBeenCalled();

    kernel.broadcastRepoProjection.mockClear();
    kernel.applyPostDispatchEffects(
      { call: "pkg.public.set", args: {} },
      { ok: true, data: { repo: "alice/demo", public: true } },
    );
    expect(kernel.broadcastPackageProjection).toHaveBeenCalledWith();
    expect(kernel.broadcastRepoProjection).toHaveBeenCalledOnce();

    kernel.applyPostDispatchEffects(
      { call: "sys.config.set", args: { key: "config/ai/model", value: "new-model" } },
      { ok: true, data: { ok: true } },
    );
    expect(kernel.broadcastConfigProjection).toHaveBeenCalledWith("config/ai/model");
  });

  it("targets user config projections and fans system config out globally", () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.broadcastMasterProjection = vi.fn();

    kernel.broadcastConfigProjection("config/ai/model");
    expect(kernel.broadcastMasterProjection).toHaveBeenLastCalledWith({
      signal: "config.changed",
      label: "configuration",
    });

    kernel.broadcastConfigProjection("users/1000/ai/model");
    expect(kernel.broadcastMasterProjection).toHaveBeenLastCalledWith({
      signal: "config.changed",
      label: "configuration",
    });

    kernel.broadcastMasterProjection.mockClear();
    kernel.broadcastConfigProjection("repos/alice/demo/visibility");
    expect(kernel.broadcastMasterProjection).not.toHaveBeenCalled();
  });
});

describe("Kernel package projection transition", () => {
  it("denies authority mutations from package-derived origins before fencing", async () => {
    const kernel = createKernel();
    const runPackageProjectionMutation = vi.fn();
    kernel.runPackageProjectionMutation = runPackageProjectionMutation;

    const result = await kernel.dispatchWithMasterProjectionGate(
      {
        type: "req",
        id: "package-origin-install",
        call: "pkg.install",
        args: { packageId: "import:root/tools:." },
      },
      { type: "app", id: "package-origin-install" },
      {
        isPackageProjectionOperation: () => true,
      },
    );

    expect(result).toMatchObject({
      handled: true,
      response: {
        ok: false,
        error: {
          code: 403,
          message: "Package-derived runtimes cannot mutate package authority",
        },
      },
    });
    expect(runPackageProjectionMutation).not.toHaveBeenCalled();
  });

  it("marks an authoritative forwarded package identity before Master dispatch", async () => {
    const kernel = createKernel();
    const identity = {
      role: "user",
      process: {
        uid: 2000,
        gid: 2000,
        gids: [2000],
        username: "pkg-agent",
        home: "/home/pkg-agent",
        cwd: "/home/pkg-agent",
      },
      capabilities: ["pkg.install"],
    };
    kernel.config = {
      get: vi.fn((key: string) => (
        key === "users/2000/pkg/owner" ? "import:root/tools:." : null
      )),
    };
    kernel.buildKernelContext = vi.fn((options: {
      packageProjectionOperation?: boolean;
    }) => ({
      isPackageProjectionOperation: () => options.packageProjectionOperation === true,
    }));
    kernel.dispatchWithMasterProjectionGate = vi.fn(async (
      _frame: unknown,
      _origin: unknown,
      context: { isPackageProjectionOperation: () => boolean },
    ) => {
      expect(context.isPackageProjectionOperation()).toBe(true);
      return {
        handled: true,
        response: {
          type: "res",
          id: "forwarded-package",
          ok: false,
          error: { code: 403, message: "denied" },
        },
      };
    });
    kernel.applyPostDispatchEffects = vi.fn();
    kernel.applyFailedMasterMutationProjectionEffects = vi.fn();
    kernel.tokenRevocationsFromResponse = vi.fn(() => []);

    await kernel.dispatchAuthorizedMasterSyscall(
      {
        callerOwnerUid: 1000,
        frame: {
          type: "req",
          id: "forwarded-package",
          call: "pkg.install",
          args: { packageId: "import:root/tools:." },
        },
      },
      "alice",
      { username: "alice", uid: 1000, generation: 4 },
      identity,
    );

    expect(kernel.buildKernelContext).toHaveBeenCalledWith(expect.objectContaining({
      packageProjectionOperation: true,
    }));
  });

  it("drains a legacy package operation before the mutation begins", async () => {
    const kernel = createKernel();
    const operation = kernel.beginUserKernelTargetOperation(1, {
      packageStamped: true,
    });
    const events: string[] = [];
    const transition = kernel.runPackageProjectionMutation(
      "legacy-drain",
      async () => {
        events.push("mutate");
        return "done";
      },
    );

    await vi.waitFor(() => expect(operation.signal.aborted).toBe(true));
    expect(events).toEqual([]);
    operation.release();
    await expect(transition).resolves.toBe("done");
    expect(events).toEqual(["mutate"]);
  });

  it("rejects competing projection revisions until exact target refresh completes", async () => {
    const kernel = createKernel();
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const events: string[] = [];
    kernel.refreshPackageProjectionTargets = vi.fn(async (
      _placements: unknown,
      _fenceId: string,
      revision: number,
    ) => {
      events.push(`refresh:${revision}:start`);
      await refreshBlocked;
      events.push(`refresh:${revision}:done`);
      return true;
    });

    const packageMutation = kernel.runPackageProjectionMutation(
      "serialized-package",
      async () => {
        events.push("package:mutate");
        return "package";
      },
    );
    await vi.waitFor(() => expect(events).toContain("refresh:2:start"));

    let configError: unknown;
    try {
      await kernel.runMasterProjectionMutation(async () => {
        events.push("config:mutate");
        return "config";
      });
    } catch (error) {
      configError = error;
    }
    expect(configError).toEqual(
      new Error("Master projection is blocked by a pending package transition"),
    );
    expect(events).not.toContain("config:mutate");

    releaseRefresh();
    await expect(packageMutation).resolves.toBe("package");
    await expect(kernel.runMasterProjectionMutation(async () => {
      events.push("config:mutate");
      return "config";
    })).resolves.toEqual({ value: "config", revision: 3 });
    expect(events).toEqual([
      "package:mutate",
      "refresh:2:start",
      "refresh:2:done",
      "config:mutate",
    ]);
  });

  it("re-establishes the legacy drain before recovered target refresh", async () => {
    const kernel = createKernel();
    const events: string[] = [];
    kernel.projectionState.enterPackageFence({
      fenceId: "recovery-fence",
      kernelGeneration: 1,
      startedAt: Date.now(),
    });
    kernel.closeUserKernelTargetAdmission = vi.fn(() => events.push("close"));
    kernel.abortPackageProjectionKernelWork = vi.fn(() => events.push("abort-kernel"));
    kernel.abortPackageProjectionProcesses = vi.fn(async () => {
      events.push("abort-processes");
    });
    kernel.waitForUserKernelTargetOperations = vi.fn(async () => {
      events.push("drain");
    });
    kernel.schedules.releaseInterruptedRuns = vi.fn(() => {
      events.push("release-schedules");
      return 1;
    });
    kernel.preparePackageProjectionTargets = vi.fn(async () => {
      events.push("prepare-targets");
    });
    kernel.refreshPackageProjectionTargets = vi.fn(async () => {
      events.push("refresh-targets");
      return true;
    });

    await kernel.recoverMasterPackageProjectionFence();

    expect(events).toEqual([
      "close",
      "abort-kernel",
      "abort-processes",
      "drain",
      "release-schedules",
      "prepare-targets",
      "refresh-targets",
    ]);
    expect(kernel.projectionState.packageFence()).toBeNull();
  });

  it("keeps a restarted target fenced until the Master's exact refresh", async () => {
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    const fence = {
      fenceId: "restart-fence",
      kernelGeneration: 4,
      startedAt: Date.now(),
    };
    const getUserKernelProjection = vi.fn(async () => ({
      username: "alice",
      projectionRevision: 7,
    }));
    const master = {
      setName: vi.fn(async () => undefined),
      getUserKernelProjection,
    };
    const clearPackageFence = vi.fn();
    const kernel = createKernel();
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = marker;
    kernel.projectionState = {
      packageFence: vi.fn(() => fence),
      clearPackageFence,
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => master),
      },
    };
    kernel.requireLocalUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    kernel.closeUserKernelTargetAdmission = vi.fn();
    kernel.abortPackageProjectionKernelWork = vi.fn();
    kernel.abortPackageProjectionProcesses = vi.fn(async () => undefined);
    kernel.waitForUserKernelTargetOperations = vi.fn(async () => undefined);
    kernel.schedules.releaseInterruptedRuns = vi.fn(() => 0);
    kernel.installUserKernelProjection = vi.fn();

    await kernel.recoverPackageProjectionFence();

    expect(getUserKernelProjection).toHaveBeenCalledWith(
      "user:alice",
      "alice",
      4,
      TEST_KERNEL_CAPABILITY,
    );
    expect(kernel.installUserKernelProjection).not.toHaveBeenCalled();
    expect(clearPackageFence).not.toHaveBeenCalled();
    expect(kernel.projectionState.packageFence()).toEqual(fence);
  });

  it("schedules retry after a transient recovery failure and later clears", async () => {
    const kernel = createKernel();
    kernel.projectionState.enterPackageFence({
      fenceId: "retry-fence",
      kernelGeneration: 1,
      startedAt: Date.now(),
    });
    kernel.schedule = vi.fn(async () => ({ id: "package-recovery" }));
    kernel.recoverMasterPackageProjectionFence = vi.fn()
      .mockRejectedValueOnce(new Error("target unavailable"))
      .mockImplementationOnce(async () => {
        kernel.projectionState.clearPackageFence("retry-fence", 1);
      });

    await kernel.onMasterPackageProjectionFenceRecoveryDue();
    expect(kernel.projectionState.packageFence()).not.toBeNull();
    expect(kernel.schedule).toHaveBeenCalledWith(
      1,
      "onMasterPackageProjectionFenceRecoveryDue",
    );

    await kernel.onMasterPackageProjectionFenceRecoveryDue();
    expect(kernel.projectionState.packageFence()).toBeNull();
  });

  it("promotes a durable pending revision before recovered target refresh", async () => {
    const kernel = createKernel();
    kernel.projectionState.enterPackageFence({
      fenceId: "pending-revision-fence",
      kernelGeneration: 1,
      startedAt: Date.now(),
    });
    expect(kernel.projectionState.beginMasterMutation()).toBe(2);
    kernel.closeUserKernelTargetAdmission = vi.fn();
    kernel.abortPackageProjectionKernelWork = vi.fn();
    kernel.abortPackageProjectionProcesses = vi.fn(async () => undefined);
    kernel.waitForUserKernelTargetOperations = vi.fn(async () => undefined);
    kernel.preparePackageProjectionTargets = vi.fn(async () => undefined);
    kernel.refreshPackageProjectionTargets = vi.fn(async (
      _placements: unknown,
      _fenceId: string,
      revision: number,
    ) => revision === 2);

    await kernel.recoverMasterPackageProjectionFence();

    expect(kernel.projectionState.recoverPendingMasterRevision).toHaveBeenCalledOnce();
    expect(kernel.refreshPackageProjectionTargets).toHaveBeenCalledWith(
      [],
      "pending-revision-fence",
      2,
    );
    expect(kernel.projectionState.packageFence()).toBeNull();
  });

  it("waits for a projection commit that begins during capability verification", async () => {
    const kernel = createKernel();
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    kernel.userKernels = { get: vi.fn(() => placement) };
    let finishAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    kernel.authorizeUserKernelCapability = vi.fn(async () => {
      await authorization;
      return placement;
    });
    const snapshot = { username: "alice", projectionRevision: 9 };
    kernel.buildUserKernelProjection = vi.fn(() => snapshot);

    const requested = kernel.getUserKernelProjection(
      "user:alice",
      "alice",
      4,
      TEST_KERNEL_CAPABILITY,
    );
    let finishCommit!: () => void;
    kernel.pendingMasterProjectionCommit = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    finishAuthorization();
    await Promise.resolve();
    expect(kernel.buildUserKernelProjection).not.toHaveBeenCalled();

    kernel.pendingMasterProjectionCommit = null;
    finishCommit();
    await expect(requested).resolves.toBe(snapshot);
  });

  it("blocks lifecycle and provisioning while durable recovery is pending", async () => {
    const kernel = createKernel();
    kernel.projectionState.enterPackageFence({
      fenceId: "blocked-lifecycle",
      kernelGeneration: 1,
      startedAt: Date.now(),
    });

    await expect(kernel.transitionUserKernelLifecycle({
      username: "alice",
      expectedGeneration: 1,
      lifecycle: "suspended",
    })).rejects.toThrow(/blocked by package projection recovery/);
    await expect(kernel.ensureUserKernelProvisioned("alice"))
      .rejects.toThrow(/blocked by package projection recovery/);
  });
});

describe("Kernel AppRunner runtime fence orchestration", () => {
  const controlRunnerName = "app-control-v3:1000:2000:pkg-chat";
  const dataRunnerName = "app-data-v2:1000:2000:pkg-chat";
  const runnerRecord = {
    runnerName: controlRunnerName,
    ownerUid: 2000,
    ownerUsername: "alice-agent",
    kernelOwnerUid: 1000,
    kernelOwnerUsername: "alice",
    packageId: "pkg-chat",
    firstSeenAt: 1,
    lastSeenAt: 1,
  };

  function buildActiveAppKernel(): { kernel: any; frame: any } {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.projectionState = {
      installed: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        kernelGeneration: 4,
        revision: 1,
        digest: `sha256:${"0".repeat(64)}`,
      })),
      packageFence: vi.fn(() => null),
    };
    kernel.auth = {
      getPasswdByUid: vi.fn((uid: number) => uid === 1000
        ? { uid: 1000, gid: 1000, username: "alice", home: "/home/alice" }
        : uid === 2000
          ? {
              uid: 2000,
              gid: 2000,
              username: "alice-agent",
              home: "/home/alice-agent",
            }
          : null),
      getPersonalAgentUid: vi.fn((uid: number) => uid === 1000 ? 2000 : null),
      getGroupByGid: vi.fn(() => null),
      getGroupByName: vi.fn(() => null),
    };
    kernel.packages = {
      resolve: vi.fn(() => ({
        packageId: "pkg-chat",
        enabled: true,
        reviewRequired: false,
        reviewedAt: null,
        updatedAt: 1_700_000_000_000,
        artifact: { hash: "sha256:chat-v1" },
        manifest: {
          name: "chat",
          entrypoints: [{ kind: "command", name: "Rpc", command: "Rpc" }],
        },
      })),
    };
    const frame = {
      uid: 2000,
      username: "alice-agent",
      kernelOwnerUid: 1000,
      kernelUsername: "alice",
      kernelGeneration: 4,
      packageId: "pkg-chat",
      packageName: "chat",
      packageUpdatedAt: 1_700_000_000_000,
      packageArtifactHash: "sha256:chat-v1",
      entrypointName: "Rpc",
      routeBase: "/rpc/chat",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    return { kernel, frame };
  }

  it("registers exact control and data runners only after current app authorization", async () => {
    const { kernel, frame } = buildActiveAppKernel();
    const registry = installTestAppRuntimeRegistry(kernel);

    await expect(kernel.authorizeAppFrame(frame, controlRunnerName)).resolves.toBe(true);
    await expect(kernel.authorizeAppFrame(frame, dataRunnerName)).resolves.toBe(true);
    expect([...registry.runners.values()]).toEqual([
      expect.objectContaining({
        runnerName: controlRunnerName,
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      }),
      expect.objectContaining({
        runnerName: dataRunnerName,
        ownerUid: 2000,
        ownerUsername: "alice-agent",
        kernelOwnerUid: 1000,
        kernelOwnerUsername: "alice",
        packageId: "pkg-chat",
      }),
    ]);

    await expect(kernel.authorizeAppFrame(
      frame,
      "app-control-v3:1000:2001:pkg-chat",
    )).resolves.toBe(false);
    kernel.appRuntimes.rememberRunner.mockImplementationOnce(() => {
      throw new Error("durable registry write failed");
    });
    await expect(kernel.authorizeAppFrame(frame, controlRunnerName)).resolves.toBe(false);
    expect(registry.runners.size).toBe(2);
  });

  it("consumes fence capabilities once and binds them to the exact controlling fence", async () => {
    const { kernel } = buildActiveAppKernel();
    const registry = installTestAppRuntimeRegistry(kernel, [runnerRecord]);
    const packageFenceId = "4f57c735-a614-4e0f-a36a-e5c60b94db15";
    kernel.projectionState = createKernel().projectionState;
    kernel.projectionState.enterPackageFence({
      fenceId: packageFenceId,
      kernelGeneration: 4,
      startedAt: 1,
    });
    const packageFence = {
      fenceKind: "package-projection",
      sourceKernelName: "user:alice",
      runnerName: controlRunnerName,
      ownerUid: 2000,
      ownerUsername: "alice-agent",
      kernelOwnerUid: 1000,
      kernelOwnerUsername: "alice",
      packageId: "pkg-chat",
      generation: 4,
      fenceId: packageFenceId,
    };
    const issue = (
      authorization: string,
      action: "prepare" | "clear",
      fence: any,
      expiresAt = Date.now() + 10_000,
    ) => {
      kernel.appRunnerRuntimeFenceAuthorizations.set(authorization, {
        expiresAt,
        action,
        fence,
      });
    };

    issue("package-ok", "prepare", packageFence);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "package-ok",
      action: "prepare",
      ...packageFence,
    })).resolves.toBe(true);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "package-ok",
      action: "prepare",
      ...packageFence,
    })).resolves.toBe(false);

    issue("wrong-action", "prepare", packageFence);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "wrong-action",
      action: "clear",
      ...packageFence,
    })).resolves.toBe(false);
    issue("wrong-tuple", "prepare", packageFence);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "wrong-tuple",
      action: "prepare",
      ...packageFence,
      packageId: "pkg-other",
    })).resolves.toBe(false);
    const wrongKernelOwner = {
      ...packageFence,
      kernelOwnerUid: 1001,
      kernelOwnerUsername: "bob",
    };
    issue("wrong-kernel-owner", "prepare", wrongKernelOwner);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "wrong-kernel-owner",
      action: "prepare",
      ...wrongKernelOwner,
    })).resolves.toBe(false);
    issue("expired", "prepare", packageFence, Date.now() - 1);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "expired",
      action: "prepare",
      ...packageFence,
    })).resolves.toBe(false);

    const foreignPackageFence = {
      ...packageFence,
      fenceId: "9ee7d668-5942-4c80-a90c-ec3b2efb8c91",
    };
    issue("foreign-package-fence", "clear", foreignPackageFence);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "foreign-package-fence",
      action: "clear",
      ...foreignPackageFence,
    })).resolves.toBe(false);

    kernel.projectionState.clearPackageFence(packageFenceId, 4);
    const lifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 4,
      fenceId: "7c9c9dc8-9d31-4682-bcdf-66512979959b",
      targetLifecycle: "suspended",
      createdAt: 1,
    };
    registry.lifecycleFences.set(1000, lifecycleFence);
    const lifecycleIdentity = {
      ...packageFence,
      fenceKind: "user-lifecycle",
      fenceId: lifecycleFence.fenceId,
    };
    issue("lifecycle-ok", "clear", lifecycleIdentity);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "lifecycle-ok",
      action: "clear",
      ...lifecycleIdentity,
    })).resolves.toBe(true);

    const differentLifecycle = {
      ...lifecycleIdentity,
      fenceId: "f0226f48-3175-4585-85e3-88e21d0eb8ab",
    };
    issue("different-lifecycle", "clear", differentLifecycle);
    await expect(kernel.consumeAppRunnerRuntimeFenceAuthorization({
      authorization: "different-lifecycle",
      action: "clear",
      ...differentLifecycle,
    })).resolves.toBe(false);
  });

  it("prepares AppRunners after the local package drain and clears them before the Kernel fence", async () => {
    const { kernel } = buildActiveAppKernel();
    installTestAppRuntimeRegistry(kernel, [runnerRecord]);
    kernel.projectionState = createKernel().projectionState;
    const events: string[] = [];
    const fenceId = "4f57c735-a614-4e0f-a36a-e5c60b94db15";
    const originalEnterFence = kernel.projectionState.enterPackageFence.getMockImplementation();
    const originalClearFence = kernel.projectionState.clearPackageFence.getMockImplementation();
    let installed: any = null;
    kernel.projectionState.installed = vi.fn(() => installed);
    kernel.projectionState.enterPackageFence.mockImplementation((fence: any) => {
      events.push("kernel-fence");
      return originalEnterFence(fence);
    });
    kernel.projectionState.clearPackageFence.mockImplementation((id: string, generation: number) => {
      events.push("kernel-clear");
      return originalClearFence(id, generation);
    });
    kernel.closeUserKernelTargetAdmission = vi.fn(() => events.push("close"));
    kernel.abortPackageProjectionKernelWork = vi.fn(() => events.push("abort-local"));
    kernel.abortPackageProjectionProcesses = vi.fn(async () => events.push("abort-process"));
    kernel.waitForUserKernelTargetOperations = vi.fn(async () => events.push("drain"));
    kernel.schedules.releaseInterruptedRuns = vi.fn(() => {
      events.push("schedule-drain");
      return 0;
    });
    kernel.requireLocalUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    kernel.installUserKernelProjection = vi.fn(async (snapshot: any) => {
      events.push("install");
      installed = {
        username: "alice",
        uid: 1000,
        kernelGeneration: 4,
        revision: snapshot.projectionRevision,
      };
    });
    const master = {
      setName: vi.fn(async () => undefined),
      consumePackageProjectionFenceAuthorization: vi.fn(async () => true),
      getUserKernelProjection: vi.fn(async () => ({ projectionRevision: 2 })),
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => master),
      },
    };
    const appRunner = {
      prepareAppRunnerRuntimeFence: vi.fn(async (input: any) => {
        expect(kernel.projectionState.packageFence()).toMatchObject({ fenceId });
        expect(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
          action: "prepare",
          ...input,
        })).toBe(true);
        events.push("app-prepare");
        return { ...input, state: "fenced" };
      }),
      clearAppRunnerRuntimeFence: vi.fn(async (input: any) => {
        expect(kernel.projectionState.packageFence()).toMatchObject({ fenceId: input.fenceId });
        expect(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
          action: "clear",
          ...input,
        })).toBe(true);
        events.push("app-clear");
        return { ...input, state: "cleared" };
      }),
    };
    kernel.ctx.exports = {
      AppRunner: { getByName: vi.fn(() => appRunner) },
    };

    await expect(kernel.preparePackageProjectionFence({
      sourceKernelName: "singleton",
      authorization: "prepare-1",
      username: "alice",
      uid: 1000,
      generation: 4,
      fenceId,
    })).resolves.toBe(true);
    expect(events).toEqual([
      "kernel-fence",
      "close",
      "abort-local",
      "abort-process",
      "drain",
      "schedule-drain",
      "app-prepare",
    ]);

    events.length = 0;
    await expect(kernel.refreshPackageProjectionFence({
      sourceKernelName: "singleton",
      username: "alice",
      uid: 1000,
      generation: 4,
      fenceId,
      expectedProjectionRevision: 2,
    })).resolves.toBe(true);
    expect(events).toEqual(["install", "app-clear", "kernel-clear"]);
    expect(kernel.projectionState.packageFence()).toBeNull();

    events.length = 0;
    kernel.projectionState.enterPackageFence({
      fenceId,
      kernelGeneration: 4,
      startedAt: 2,
    });
    master.getUserKernelProjection.mockResolvedValueOnce({ projectionRevision: 3 });
    appRunner.clearAppRunnerRuntimeFence.mockImplementationOnce(async (input: any) => {
      expect(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
        action: "clear",
        ...input,
      })).toBe(true);
      throw new Error("AppRunner clear unavailable");
    });
    await expect(kernel.refreshPackageProjectionFence({
      sourceKernelName: "singleton",
      username: "alice",
      uid: 1000,
      generation: 4,
      fenceId,
      expectedProjectionRevision: 3,
    })).rejects.toThrow("AppRunner clear unavailable");
    expect(kernel.projectionState.packageFence()).toMatchObject({ fenceId });
    expect(events).not.toContain("kernel-clear");
  });

  it("persists and drains only the legacy owner before committing placement", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    const aliceRunner = runnerRecord;
    const bobRunner = {
      ...runnerRecord,
      runnerName: "app-control-v3:1001:3000:pkg-chat",
      ownerUid: 3000,
      ownerUsername: "bob-agent",
      kernelOwnerUid: 1001,
      kernelOwnerUsername: "bob",
    };
    const registry = installTestAppRuntimeRegistry(kernel, [aliceRunner, bobRunner]);
    const events: string[] = [];
    kernel.appRuntimes.beginLifecycleFence.mockImplementation((fence: any) => {
      events.push("persist-fence");
      const existing = registry.lifecycleFences.get(fence.ownerUid);
      if (existing && JSON.stringify(existing) !== JSON.stringify(fence)) {
        throw new Error("A different AppRunner lifecycle fence is active");
      }
      registry.lifecycleFences.set(fence.ownerUid, existing ?? fence);
      return existing ?? fence;
    });
    let placement: any = {
      username: "alice",
      uid: 1000,
      lifecycle: "legacy",
      generation: 1,
      createdAt: 1,
      updatedAt: 1,
      retiredAt: null,
    };
    kernel.userKernels = {
      get: vi.fn(() => placement),
      beginProvisioning: vi.fn(() => {
        events.push("commit-placement");
        placement = { ...placement, lifecycle: "provisioning" };
        return placement;
      }),
    };
    const aliceConnection = {
      id: "alice-connection",
      state: { identity: { process: { uid: 1000 } } },
      close: vi.fn(() => events.push("close-alice")),
    };
    const bobConnection = {
      id: "bob-connection",
      state: { identity: { process: { uid: 1001 } } },
      close: vi.fn(),
    };
    kernel.connections = new Map([
      [aliceConnection.id, aliceConnection],
      [bobConnection.id, bobConnection],
    ]);
    const aliceSchedule = new AbortController();
    const bobSchedule = new AbortController();
    kernel.activeScheduleRuns = new Map([
      ["alice-schedule", aliceSchedule],
      ["bob-schedule", bobSchedule],
    ]);
    kernel.schedules = {
      getStored: vi.fn((id: string) => ({ ownerUid: id === "alice-schedule" ? 1000 : 1001 })),
      releaseInterruptedRunsForOwner: vi.fn(() => {
        events.push("release-owner-schedules");
        return 1;
      }),
    };
    const processes = [
      { processId: "alice-process", ownerUid: 1000, kernelGeneration: null },
      { processId: "bob-process", ownerUid: 1001, kernelGeneration: null },
    ];
    kernel.procs = {
      list: vi.fn(() => processes),
      get: vi.fn((id: string) => processes.find((process) => process.processId === id) ?? null),
    };
    let drainedOrigins: any[] = [];
    kernel.routes = {
      drainForOrigins: vi.fn((origins: any[]) => {
        drainedOrigins = origins;
        events.push("drain-routes");
        return [{
          id: "route-1",
          deviceId: "device-1",
          driverConnectionId: "driver-1",
          scheduleId: null,
        }];
      }),
    };
    kernel.runRoutes = { clearForUid: vi.fn(() => events.push("clear-run-routes")) };
    kernel.sendDeviceRequestCancel = vi.fn();
    kernel.routedBodies = new Map();
    kernel.cancelSchedule = vi.fn(async () => undefined);
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => {
      events.push("abort-owner-processes");
    });
    kernel.applyUserKernelLifecycleTargetFence = vi.fn(async () => {
      events.push("target-fence");
      expect(kernel.appRuntimes.getLifecycleFence(1000)).not.toBeNull();
      return {
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        lifecycle: "provisioning",
        generation: 1,
        updatedAt: 2,
      };
    });
    const fenceAuthorizations: boolean[] = [];
    const aliceAppRunner = {
      prepareAppRunnerRuntimeFence: vi.fn(async (input: any) => {
        fenceAuthorizations.push(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
          action: "prepare",
          ...input,
        }));
        events.push("prepare-alice-runner");
        return { ...input, state: "fenced" };
      }),
    };
    const selectedRunnerNames: string[] = [];
    kernel.ctx.exports = {
      AppRunner: {
        getByName: vi.fn((name: string) => {
          selectedRunnerNames.push(name);
          return aliceAppRunner;
        }),
      },
    };
    kernel.userKernelLifecycleAuthorizations = new Map();
    kernel.queueAppRuntimeLifecycleFenceRecovery = vi.fn();

    const transition = kernel.transitionUserKernelLifecycle({
      username: "alice",
      expectedGeneration: 1,
      lifecycle: "provisioning",
    });
    await expect(transition).resolves.toMatchObject({ lifecycle: "provisioning" });
    expect(aliceConnection.close).toHaveBeenCalledOnce();
    expect(bobConnection.close).not.toHaveBeenCalled();
    expect(aliceSchedule.signal.aborted).toBe(true);
    expect(bobSchedule.signal.aborted).toBe(false);
    expect(drainedOrigins).toEqual(expect.arrayContaining([
      { type: "connection", id: "alice-connection" },
      { type: "process", id: "alice-process" },
    ]));
    expect(drainedOrigins).not.toContainEqual({ type: "connection", id: "bob-connection" });
    expect(drainedOrigins).not.toContainEqual({ type: "process", id: "bob-process" });
    expect(kernel.abortFencedUserKernelProcesses).toHaveBeenCalledWith(
      1,
      "User Kernel is migrating from the legacy runtime",
      1000,
    );
    expect(aliceAppRunner.prepareAppRunnerRuntimeFence).toHaveBeenCalledOnce();
    expect(fenceAuthorizations).toEqual([true]);
    expect(selectedRunnerNames).toEqual([aliceRunner.runnerName]);
    expect(events.indexOf("persist-fence")).toBeLessThan(events.indexOf("abort-owner-processes"));
    expect(events.indexOf("abort-owner-processes"))
      .toBeLessThan(events.indexOf("prepare-alice-runner"));
    expect(events.indexOf("prepare-alice-runner")).toBeLessThan(events.indexOf("target-fence"));
    expect(events.indexOf("target-fence")).toBeLessThan(events.indexOf("commit-placement"));
  });

  it("keeps a legacy lifecycle row across a lost clear ack and retries idempotently", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    const lifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "singleton",
      generation: 1,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    };
    const registry = installTestAppRuntimeRegistry(kernel, [runnerRecord], [lifecycleFence]);
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 1,
      createdAt: 1,
      updatedAt: 2,
      retiredAt: null,
    };
    kernel.userKernels = { get: vi.fn(() => placement) };
    kernel.userKernelActivationAuthorizations = new Map();
    const target = {
      setName: vi.fn(async () => undefined),
      activateProvisionedUserKernel: vi.fn(async () => ({
        version: 1,
        kind: "user",
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        generation: 1,
        updatedAt: 2,
      })),
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "user:alice" })),
        get: vi.fn(() => target),
      },
    };
    let clearAttempts = 0;
    let cleanupCount = 0;
    let locallyCleared = false;
    const appRunner = {
      clearAppRunnerRuntimeFence: vi.fn(async (input: any) => {
        expect(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
          action: "clear",
          ...input,
        })).toBe(true);
        clearAttempts += 1;
        if (!locallyCleared) {
          locallyCleared = true;
          cleanupCount += 1;
        }
        if (clearAttempts === 1) throw new Error("clear acknowledgment lost");
        return { ...input, state: "cleared" };
      }),
    };
    kernel.ctx.exports = { AppRunner: { getByName: vi.fn(() => appRunner) } };

    await expect(kernel.completeUserKernelActivation(placement))
      .rejects.toThrow("clear acknowledgment lost");
    expect(registry.lifecycleFences.get(1000)).toEqual(lifecycleFence);
    await expect(kernel.completeUserKernelActivation(placement)).resolves.toEqual(placement);
    expect(clearAttempts).toBe(2);
    expect(cleanupCount).toBe(1);
    expect(registry.lifecycleFences.has(1000)).toBe(false);
  });

  it("exact-clears a local lifecycle runner before admitting an activated target", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const provisioning = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 5,
      lifecycle: "provisioning",
      updatedAt: 1,
    };
    const lifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 4,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "suspended",
      createdAt: 1,
    };
    const localRunner = {
      ...runnerRecord,
      runnerName: "app-control-v3:1000:1000:pkg-chat",
      ownerUid: 1000,
      ownerUsername: "alice",
    };
    const registry = installTestAppRuntimeRegistry(kernel, [localRunner], [lifecycleFence]);
    kernel.userKernelMarker = provisioning;
    kernel.ctx.storage = {
      get: vi.fn(async () => provisioning),
      put: vi.fn(async () => undefined),
      transactionSync: vi.fn((closure: () => unknown) => closure()),
    };
    kernel.requireLocalUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    kernel.pullAuthorizedUserKernelActivationProjection = vi.fn(async () => ({
      version: 1,
      username: "alice",
      uid: 1000,
      generation: 5,
      projectionRevision: 2,
      accounts: [{
        entry: {
          username: "alice",
          uid: 1000,
          gid: 1000,
          gecos: "Alice",
          home: "/home/alice",
          shell: "/bin/sh",
        },
        kind: "human",
        locked: false,
      }],
      groups: [],
      personalAgentUid: null,
      capabilities: [],
      config: [],
      packages: [],
    }));
    kernel.installUserKernelProjection = vi.fn(async () => undefined);
    kernel.discardPreparedUserKernelExecutors = vi.fn(async () => undefined);
    kernel.rebindFencedUserKernelProcesses = vi.fn();
    kernel.ensureUserKernelProvisioningExecutor = vi.fn(async () => "proc:alice");
    const schedule = {
      id: "schedule-1",
      enabled: true,
      wakeScheduleId: null as string | null,
      state: { nextRunAtMs: Date.now() - 1, runningAtMs: null },
    };
    kernel.schedules = {
      listWakeable: vi.fn(() => [schedule]),
      getStored: vi.fn(() => schedule),
      setWakeScheduleId: vi.fn((_id: string, wakeId: string) => {
        schedule.wakeScheduleId = wakeId;
      }),
    };
    kernel.scheduleScheduleWake = vi.fn()
      .mockResolvedValueOnce("wake-before-open")
      .mockResolvedValueOnce("wake-after-open");
    kernel.cancelSchedule = vi.fn(async () => undefined);
    kernel.runSchedules = vi.fn(async () => ({ ran: 1, results: [] }));
    const rearmPendingSchedules = kernel.rearmPendingSchedules.bind(kernel);
    let rearmPass = 0;
    kernel.rearmPendingSchedules = vi.fn(async (...args: unknown[]) => {
      await rearmPendingSchedules(...args);
      rearmPass += 1;
      if (rearmPass === 1) {
        await kernel.onScheduleDue("schedule-1", { id: "wake-before-open" });
      }
    });
    const appRunner = {
      clearAppRunnerRuntimeFence: vi.fn(async (input: any) => {
        expect(await kernel.consumeAppRunnerRuntimeFenceAuthorization({
          action: "clear",
          ...input,
        })).toBe(true);
        return { ...input, state: "cleared" };
      }),
    };
    kernel.ctx.exports = { AppRunner: { getByName: vi.fn(() => appRunner) } };

    await expect(kernel.activateProvisionedUserKernel({
      sourceKernelName: "singleton",
      authorization: "activate-1",
      username: "alice",
      uid: 1000,
      generation: 5,
    })).resolves.toMatchObject({ lifecycle: "active", generation: 5 });
    expect(appRunner.clearAppRunnerRuntimeFence).toHaveBeenCalledOnce();
    expect(registry.lifecycleFences.has(1000)).toBe(false);
    expect(kernel.runSchedules).not.toHaveBeenCalled();
    expect(kernel.scheduleScheduleWake).toHaveBeenCalledTimes(2);
    expect(schedule.wakeScheduleId).toBe("wake-after-open");
    expect(kernel.cancelSchedule).toHaveBeenCalledWith("wake-before-open");
  });

  it("denies generic target work and due schedules while a lifecycle row exists", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    const lifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 4,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    };
    const registry = installTestAppRuntimeRegistry(kernel, [], [lifecycleFence]);
    kernel.userKernelMarker = marker;
    kernel.schedules = {
      getStored: vi.fn(() => ({ wakeScheduleId: "wake-1" })),
    };
    kernel.runSchedules = vi.fn(async () => ({ ran: 1, results: [] }));

    expect(() => kernel.beginUserKernelTargetOperation(4))
      .toThrow("User Kernel target operation admission is closed");
    await expect(kernel.requireActiveUserKernel(4))
      .rejects.toThrow("User Kernel is not active");
    expect(kernel.hasActiveUserKernelGeneration(4)).toBe(false);
    await kernel.onScheduleDue("schedule-1", { id: "wake-1" });
    expect(kernel.runSchedules).not.toHaveBeenCalled();

    expect(kernel.appRuntimes.clearLifecycleFence(lifecycleFence)).toBe(true);
    expect(registry.lifecycleFences.has(1000)).toBe(false);
    const operation = kernel.beginUserKernelTargetOperation(4);
    operation.assertCurrent();
    operation.release();
    await expect(kernel.requireActiveUserKernel(4)).resolves.toEqual(marker);
    expect(kernel.hasActiveUserKernelGeneration(4)).toBe(true);
    await kernel.onScheduleDue("schedule-1", { id: "wake-1" });
    expect(kernel.runSchedules).toHaveBeenCalledWith({
      id: "schedule-1",
      mode: "due",
    });
  });

  it("resumes an active-marker lifecycle recovery without aborting its executor", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 4,
      lifecycle: "active",
      updatedAt: 2,
    };
    const lifecycleFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "user:alice",
      generation: 4,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    };
    installTestAppRuntimeRegistry(kernel, [], [lifecycleFence]);
    kernel.userKernelMarker = marker;
    kernel.fenceUserKernelRuntime = vi.fn();
    kernel.abortFencedUserKernelProcesses = vi.fn(async () => undefined);
    kernel.prepareRegisteredAppRunners = vi.fn(async () => undefined);
    kernel.requireLocalUserKernelCapability = vi.fn(async () => TEST_KERNEL_CAPABILITY);
    const projection = { version: 1, username: "alice", uid: 1000, generation: 4 };
    const master = {
      setName: vi.fn(async () => undefined),
      getUserKernelProjection: vi.fn(async () => projection),
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => ({ name: "singleton" })),
        get: vi.fn(() => master),
      },
    };
    kernel.activateUserKernelFromProjection = vi.fn(async () => marker);

    await kernel.recoverAppRuntimeLifecycleFences();

    expect(kernel.fenceUserKernelRuntime)
      .toHaveBeenCalledWith("User Kernel lifecycle recovery is fenced");
    expect(kernel.abortFencedUserKernelProcesses).not.toHaveBeenCalled();
    expect(kernel.prepareRegisteredAppRunners).not.toHaveBeenCalled();
    expect(master.getUserKernelProjection).toHaveBeenCalledWith(
      "user:alice",
      "alice",
      4,
      TEST_KERNEL_CAPABILITY,
    );
    expect(kernel.activateUserKernelFromProjection)
      .toHaveBeenCalledWith(marker, projection, "alice");
  });

  it("recovers Master lifecycle rows from the authoritative placement state", async () => {
    const kernel = createKernel() as any;
    const activeFence = {
      ownerUid: 1000,
      ownerUsername: "alice",
      sourceKernelName: "singleton",
      generation: 4,
      fenceId: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    };
    const legacyFence = {
      ownerUid: 1001,
      ownerUsername: "bob",
      sourceKernelName: "singleton",
      generation: 1,
      fenceId: "5f57c735-a614-4e0f-a36a-e5c60b94db15",
      targetLifecycle: "provisioning",
      createdAt: 1,
    };
    installTestAppRuntimeRegistry(kernel, [], [activeFence, legacyFence]);
    const activePlacement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    const legacyPlacement = {
      username: "bob",
      uid: 1001,
      lifecycle: "legacy",
      generation: 1,
    };
    kernel.userKernels = {
      getByUid: vi.fn((uid: number) => uid === 1000 ? activePlacement : legacyPlacement),
    };
    kernel.completeUserKernelActivation = vi.fn(async () => activePlacement);
    kernel.transitionUserKernelLifecycle = vi.fn(async () => ({
      ...legacyPlacement,
      lifecycle: "provisioning",
    }));

    await kernel.recoverAppRuntimeLifecycleFences();

    expect(kernel.completeUserKernelActivation).toHaveBeenCalledWith(activePlacement);
    expect(kernel.transitionUserKernelLifecycle).toHaveBeenCalledWith({
      username: "bob",
      expectedGeneration: 1,
      lifecycle: "provisioning",
    });
  });
});

describe("Kernel package app authorization", () => {
  it("caches a Master-certified placement and verifies routes in the owning user Kernel", async () => {
    const values = new Map<string, unknown>();
    const marker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
      updatedAt: Date.now(),
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => ({
          version: 1,
          username: "alice",
          uid: 1000,
          generation: 4,
          secret: TEST_KERNEL_CAPABILITY,
        })),
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
        },
      },
    };
    kernel.userKernelMarker = marker;
    kernel.projectionState = { packageFence: vi.fn(() => null) };
    kernel.activeTargetOperations = new Map();
    kernel.targetOperationDrainWaiters = new Map();
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        username: "alice",
      })),
    };
    const master = {
      setName: vi.fn(async () => undefined),
      issueAppPlacementCertificate: vi.fn(async () => ({
        version: 1,
        username: "alice",
        uid: 1000,
        generation: 4,
        certificate: TEST_APP_PLACEMENT_CERTIFICATE,
      })),
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => master),
      },
    };

    const sessionId = await kernel.issueAppSessionId({
      username: "alice",
      uid: 1000,
    });
    const routed = parseRoutedAppSessionId(sessionId);
    expect(routed).toMatchObject({
      username: "alice",
      uid: 1000,
      generation: 4,
      placementCertificate: TEST_APP_PLACEMENT_CERTIFICATE,
    });
    expect(values.size).toBe(2);
    await kernel.issueAppSessionId({ username: "alice", uid: 1000 });
    expect(master.issueAppPlacementCertificate).toHaveBeenCalledOnce();
    await expect(kernel.authorizeAppSessionRoute(sessionId)).resolves.toBe(true);

    const tamperedParts = sessionId.split("~");
    tamperedParts[7] = `B${tamperedParts[7]!.slice(1)}`;
    const tampered = tamperedParts.join("~");
    expect(parseRoutedAppSessionId(tampered)).not.toBeNull();
    await expect(kernel.authorizeAppSessionRoute(tampered)).resolves.toBe(false);

    const masterKernel = createKernel() as any;
    Object.defineProperty(masterKernel, "name", { value: "singleton" });
    await expect(masterKernel.resolveAppSessionKernel(sessionId)).resolves.toEqual({ ok: false });

    marker.lifecycle = "suspended";
    await expect(kernel.authorizeAppSessionRoute(sessionId)).resolves.toBe(false);
  });

  it("lets only an exact capability-bound active placement obtain a Master certificate", async () => {
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    const durableValues = new Map<string, unknown>();
    const releaseOperation = vi.fn();
    let publishedVerificationKey = "";
    let publishedVerificationOptions: R2PutOptions | undefined;
    const master = createKernel() as any;
    Object.defineProperty(master, "name", { value: "singleton" });
    master.userKernels = { get: vi.fn(() => placement) };
    master.authorizeUserKernelCapability = vi.fn(async () => placement);
    master.beginMasterUserOperation = vi.fn(() => releaseOperation);
    master.ctx = {
      storage: {
        get: vi.fn(async (key: string) => durableValues.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          durableValues.set(key, value);
        }),
      },
    };
    master.env = {
      STORAGE: {
        head: vi.fn(async () => null),
        put: vi.fn(async (
          _key: string,
          value: string,
          options?: R2PutOptions,
        ) => {
          publishedVerificationKey = value;
          publishedVerificationOptions = options;
          return {};
        }),
      },
    };

    const proof = {
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: TEST_KERNEL_CAPABILITY,
    };
    const grant = await master.issueAppPlacementCertificate(proof);

    expect(grant).toMatchObject({
      version: 1,
      username: "alice",
      uid: 1000,
      generation: 4,
    });
    expect(master.authorizeUserKernelCapability).toHaveBeenCalledWith(proof);
    expect(master.beginMasterUserOperation).toHaveBeenCalledWith("alice");
    expect(releaseOperation).toHaveBeenCalledOnce();
    expect(publishedVerificationOptions?.customMetadata).toMatchObject({
      uid: "0",
      gid: "0",
      mode: "444",
      gsvInternal: "app-placement-verification-key-v1",
    });
    const verificationRecord = parseSerializedAppPlacementVerificationKeyRecord(
      publishedVerificationKey,
    );
    expect(verificationRecord).not.toBeNull();
    await expect(verifyAppPlacementCertificate(
      await importAppPlacementVerificationKey(verificationRecord!),
      { username: "alice", uid: 1000, generation: 4 },
      grant!.certificate,
    )).resolves.toBe(true);

    const denied = createKernel() as any;
    Object.defineProperty(denied, "name", { value: "singleton" });
    denied.authorizeUserKernelCapability = vi.fn(async () => null);
    await expect(denied.issueAppPlacementCertificate(proof)).resolves.toBeNull();
  });

  it("fails closed instead of silently rotating an orphaned edge trust anchor", async () => {
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "active",
      generation: 4,
    };
    const publish = vi.fn();
    const master = createKernel() as any;
    master.userKernels = { get: vi.fn(() => placement) };
    master.authorizeUserKernelCapability = vi.fn(async () => placement);
    master.beginMasterUserOperation = vi.fn(() => vi.fn());
    master.ctx = {
      storage: {
        get: vi.fn(async () => undefined),
        put: vi.fn(),
      },
    };
    master.env = {
      STORAGE: {
        head: vi.fn(async () => ({ key: "orphaned-public-key" })),
        put: publish,
      },
    };

    await expect(master.issueAppPlacementCertificate({
      sourceKernelName: "user:alice",
      uid: 1000,
      generation: 4,
      kernelCapability: TEST_KERNEL_CAPABILITY,
    })).rejects.toThrow("signing key recovery is required");
    expect(master.ctx.storage.put).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("routes bare session ids only for an explicit live legacy placement", async () => {
    const placement = {
      username: "alice",
      uid: 1000,
      lifecycle: "legacy",
      generation: 1,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.userKernels = { get: vi.fn(() => placement) };
    kernel.appSessions = {
      getActiveRoute: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        expiresAt: Date.now() + 60_000,
      })),
    };
    const sessionId = "4f57c735-a614-4e0f-a36a-e5c60b94db15";

    await expect(kernel.resolveAppSessionKernel(sessionId)).resolves.toMatchObject({
      ok: true,
      kernelName: "singleton",
      lifecycle: "legacy",
    });
    placement.lifecycle = "retired";
    await expect(kernel.resolveAppSessionKernel(sessionId)).resolves.toEqual({ ok: false });
  });

  it("preflights an active routed locator only on its exact user Kernel generation", async () => {
    const route = {
      username: "alice",
      uid: 1000,
      generation: 2,
      expiresAt: Date.now() + 60_000,
      nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      placementCertificate: TEST_APP_PLACEMENT_CERTIFICATE,
    };
    const values = new Map<string, string>();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice", configurable: true });
    kernel.ctx = {
      storage: {
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: string) => values.set(key, value),
        },
      },
    };
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 2,
      lifecycle: "active",
      updatedAt: Date.now(),
    };
    kernel.projectionState = { packageFence: vi.fn(() => null) };
    kernel.activeTargetOperations = new Map();
    kernel.targetOperationDrainWaiters = new Map();
    const signRoute = async (input: typeof route) => buildRoutedAppSessionId(
      input,
      await kernel.signAppSessionRoute(buildRoutedAppSessionSigningInput(input)),
    );
    const forgedSignature = buildRoutedAppSessionId(route, "A".repeat(43));
    await expect(kernel.authorizeAppSessionRoute(forgedSignature)).resolves.toBe(false);
    expect(values.size).toBe(0);

    const sessionId = await signRoute(route);

    await expect(kernel.authorizeAppSessionRoute(sessionId)).resolves.toBe(true);
    for (const forged of [
      await signRoute({ ...route, username: "bob" }),
      await signRoute({ ...route, uid: 1001 }),
      await signRoute({ ...route, generation: 3 }),
      await signRoute({ ...route, expiresAt: Date.now() - 1 }),
      "4f57c735-a614-4e0f-a36a-e5c60b94db15",
    ]) {
      await expect(kernel.authorizeAppSessionRoute(forged)).resolves.toBe(false);
    }

    kernel.userKernelMarker.lifecycle = "suspended";
    await expect(kernel.authorizeAppSessionRoute(sessionId)).resolves.toBe(false);

    Object.defineProperty(kernel, "name", { value: "singleton", configurable: true });
    await expect(kernel.authorizeAppSessionRoute(sessionId)).resolves.toBe(false);
  });

  it.each(["resolve", "refresh"] as const)(
    "holds an exact package-stamped lease through app session %s",
    async (mode) => {
      const sessionId = buildRoutedAppSessionId({
        username: "alice",
        uid: 1000,
        generation: 7,
        expiresAt: Date.now() + 60_000,
        nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
        placementCertificate: TEST_APP_PLACEMENT_CERTIFICATE,
      }, "A".repeat(43));
      const clientSession = {
        sessionId,
        clientId: "window-1",
        uid: 1000,
        username: "alice",
        packageId: "pkg-chat",
        packageName: "chat",
        entrypointName: "Chat",
        routeBase: "/apps/chat",
        rpcBase: `/apps/sessions/${encodeURIComponent(sessionId)}/clients/window-1/socket`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30_000,
      };
      const assertCurrent = vi.fn();
      const release = vi.fn();
      const beginUserKernelTargetOperation = vi.fn(() => ({
        generation: 7,
        signal: new AbortController().signal,
        markPackageStamped: vi.fn(),
        assertCurrent,
        release,
      }));
      const sessionAccess = vi.fn(async (...args: unknown[]) => {
        const guard = args.at(-1);
        expect(guard).toBe(assertCurrent);
        (guard as () => void)();
        return clientSession;
      });
      const expected = { ok: false, status: 404, message: "test result" };
      const kernel = createKernel() as any;
      Object.defineProperty(kernel, "name", { value: "user:alice" });
      kernel.beginUserKernelTargetOperation = beginUserKernelTargetOperation;
      kernel.acceptsLocalAppSessionRoute = vi.fn(async () => true);
      kernel.appSessions = mode === "refresh"
        ? { refresh: sessionAccess }
        : { resolve: sessionAccess };
      kernel.resolvePackageAppSessionContext = vi.fn(async () => expected);

      const result = mode === "refresh"
        ? await kernel.refreshPackageAppRpcSession({ sessionId, secret: "secret" })
        : await kernel.resolvePackageAppRpcSession({ sessionId, secret: "secret" });

      expect(result).toBe(expected);
      expect(beginUserKernelTargetOperation).toHaveBeenCalledWith(7, {
        packageStamped: true,
      });
      expect(kernel.acceptsLocalAppSessionRoute).toHaveBeenCalledWith(sessionId);
      expect(assertCurrent).toHaveBeenCalledTimes(4);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("authorizes an active user frame only while its local client and entrypoint match", async () => {
    const sessionId = buildRoutedAppSessionId({
      username: "alice",
      uid: 1000,
      generation: 2,
      expiresAt: Date.now() + 60_000,
      nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
      placementCertificate: TEST_APP_PLACEMENT_CERTIFICATE,
    }, "A".repeat(43));
    const frame = {
      uid: 1000,
      username: "alice",
      kernelOwnerUid: 1000,
      kernelUsername: "alice",
      kernelGeneration: 2,
      sessionId,
      clientId: "window-1",
      packageId: "pkg-chat",
      packageName: "chat",
      packageUpdatedAt: 1_700_000_000_000,
      packageArtifactHash: "sha256:chat-v1",
      entrypointName: "Chat",
      routeBase: "/apps/chat",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    };
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: "alice",
      uid: 1000,
      generation: 2,
      lifecycle: "active",
      updatedAt: Date.now(),
    };
    kernel.projectionState = {
      installed: vi.fn(() => ({
        username: "alice",
        uid: 1000,
        kernelGeneration: 2,
        revision: 1,
        digest: `sha256:${"0".repeat(64)}`,
      })),
      packageFence: vi.fn(() => null),
    };
    kernel.activeTargetOperations = new Map();
    kernel.targetOperationDrainWaiters = new Map();
    kernel.auth = {
      getPasswdByUid: vi.fn((uid: number) => uid === 1000
        ? {
            uid: 1000,
            gid: 1000,
            username: "alice",
            home: "/home/alice",
          }
        : null),
    };
    kernel.packages = {
      resolve: vi.fn((packageId: string) => packageId === "pkg-chat"
          ? {
            enabled: true,
            updatedAt: 1_700_000_000_000,
            artifact: { hash: "sha256:chat-v1" },
            manifest: {
              name: "chat",
              entrypoints: [{
                kind: "ui",
                name: "Chat",
                route: "/apps/chat",
              }],
            },
          }
        : null),
    };
    kernel.appSessions = {
      getActiveForUid: vi.fn((uid: number, requestedSessionId: string) => (
        uid === 1000 && requestedSessionId === sessionId
          ? {
              sessionId,
              uid: 1000,
              username: "alice",
              packageId: "pkg-chat",
              packageName: "chat",
              entrypointName: "Chat",
              routeBase: "/apps/chat",
              clients: [{ clientId: "window-1" }],
            }
          : null
      )),
    };

    await expect(kernel.authorizeAppFrame(frame)).resolves.toBe(true);
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => {
          throw new Error("active app authorization must not select Master");
        }),
      },
    };
    await expect(kernel.isAuthoritativeLocalAppFrame(frame)).resolves.toBe(true);
    for (const forged of [
      { ...frame, uid: 0 },
      { ...frame, username: "root" },
      { ...frame, kernelOwnerUid: 1001 },
      { ...frame, kernelUsername: "bob" },
      { ...frame, kernelGeneration: 3 },
      { ...frame, packageId: "pkg-admin" },
      { ...frame, packageName: "admin" },
      { ...frame, packageUpdatedAt: 1 },
      { ...frame, packageArtifactHash: "sha256:admin" },
      { ...frame, entrypointName: "Admin" },
      { ...frame, routeBase: "/apps/admin" },
    ]) {
      await expect(kernel.authorizeAppFrame(forged)).resolves.toBe(false);
    }
    kernel.appSessions.getActiveForUid.mockReturnValue(null);
    await expect(kernel.authorizeAppFrame(frame)).resolves.toBe(false);
  });

  it("uses account capabilities without elevating from the package manifest", () => {
    const kernel = createKernel() as any;
    kernel.auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "alice",
        home: "/home/alice",
      })),
      resolveGids: vi.fn(() => [1000, 100]),
    };
    kernel.caps = { resolve: vi.fn(() => ["fs.read"]) };

    const identity = kernel.buildAppBindingIdentity(
      {
        uid: 1000,
        username: "alice",
        packageId: "pkg-admin",
        packageName: "admin",
        entrypointName: "main",
        routeBase: "/apps/admin",
        issuedAt: 1,
        expiresAt: 2,
      },
      ["sys.config.set"],
    );

    expect(identity?.capabilities).toEqual(["fs.read"]);
    expect(kernel.caps.resolve).toHaveBeenCalledWith([1000, 100]);
  });
});

describe("Kernel service binding identity", () => {
  it("rejects service calls instead of fabricating a missing root account", async () => {
    const kernel = createKernel() as any;
    kernel.auth = { getPasswdByUid: vi.fn(() => null) };
    kernel.caps = { resolve: vi.fn(() => []) };

    await expect(kernel.handleServiceReq({
      type: "req",
      id: "service-without-root",
      call: "adapter.status",
      args: { adapter: "discord" },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 503,
        message: "Service identity is not configured",
      },
    });
  });
});

describe("Kernel MCP connection cleanup", () => {
  it("rejects an MCP OAuth token commit after the user Kernel generation changes", async () => {
    const tokenPut = vi.fn(async () => undefined);
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.ctx = {
      storage: {
        transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            get: vi.fn(async () => ({
              version: 1,
              kind: "user",
              username: "alice",
              uid: 1000,
              generation: 5,
              lifecycle: "suspended",
              updatedAt: 2,
            })),
            put: tokenPut,
          })),
      },
    };

    const provider = kernel.createMcpOAuthProvider(
      "https://gsv.example.com/oauth/callback/alice/4",
    ) as any;
    provider.serverId = "mcp-server-1";
    provider.clientId = "client-1";

    await expect(provider.saveTokens({
      access_token: "secret",
      token_type: "Bearer",
    })).rejects.toThrow("User Kernel is not active");
    expect(tokenPut).not.toHaveBeenCalled();
  });

  it("removes newly registered MCP servers when the initial connection fails", async () => {
    const kernel = createKernel() as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        callbackHost: string;
        transport: { type: "auto" };
      }): Promise<unknown>;
      createMcpOAuthProvider: ReturnType<typeof vi.fn>;
      mcp: {
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
      removeMcpServer: ReturnType<typeof vi.fn>;
    };
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.createMcpOAuthProvider = vi.fn(() => ({}));
    kernel.mcp = {
      registerServer: vi.fn(async () => undefined),
      connectToServer: vi.fn(async () => ({
        state: "failed",
        error: "connection rejected",
      })),
    };
    kernel.removeMcpServer = vi.fn(async () => undefined);
    const expectedError =
      "Failed to connect to MCP server at https://tinyfish.example/mcp: connection rejected";

    await expect(
      kernel.addMcpServerConnection({
        uid: 1000,
        name: "TinyFish",
        url: "https://tinyfish.example/mcp",
        callbackHost: "https://gsv.example.com",
        transport: { type: "auto" },
      }),
    ).rejects.toThrow(expectedError);

    const serverId = kernel.mcp.registerServer.mock.calls[0][0];
    expect(kernel.removeMcpServer).toHaveBeenCalledWith(serverId);
  });

  it("passes custom MCP headers as serializable request options", async () => {
    type RegisteredServerOptions = {
      transport: {
        requestInit?: {
          headers?: Record<string, string>;
        };
      };
    };
    const kernel = createKernel() as {
      addMcpServerConnection(input: {
        uid: number;
        name: string;
        url: string;
        callbackHost: string;
        transport: {
          type: "sse";
          headers: Record<string, string>;
        };
      }): Promise<unknown>;
      createMcpOAuthProvider: ReturnType<typeof vi.fn>;
      mcp: {
        registerServer: ReturnType<typeof vi.fn>;
        connectToServer: ReturnType<typeof vi.fn>;
      };
    };
    let registeredOptions: RegisteredServerOptions | null = null;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.createMcpOAuthProvider = vi.fn(() => ({}));
    kernel.mcp = {
      registerServer: vi.fn(async (_serverId: string, options: RegisteredServerOptions) => {
        registeredOptions = options;
      }),
      connectToServer: vi.fn(async () => ({
        state: "authenticating",
        authUrl: "https://tinyfish.example/oauth",
      })),
    };

    await kernel.addMcpServerConnection({
      uid: 1000,
      name: "TinyFish",
      url: "https://tinyfish.example/mcp",
      callbackHost: "https://gsv.example.com",
      transport: {
        type: "sse",
        headers: {
          Authorization: "Bearer user-token",
          "X-API-Key": "custom-key",
        },
      },
    });

    expect(JSON.parse(JSON.stringify(registeredOptions?.transport.requestInit))).toEqual({
      headers: {
        Authorization: "Bearer user-token",
        "X-API-Key": "custom-key",
      },
    });
  });
});

describe("Kernel process device requests", () => {
  function buildKernelForDeviceRequest(options: {
    capabilities?: string[];
    implements?: string[];
  } = {}) {
    const device = {
      device_id: "linux-machine",
      owner_uid: 0,
      label: "Linux machine",
      description: "",
      implements: options.implements ?? ["net.fetch"],
      platform: "linux",
      version: "test",
      online: true,
      first_seen_at: 1,
      last_seen_at: 2,
      connected_at: 2,
      disconnected_at: null,
    };
    const requestDevice = vi.fn(async () => ({
      type: "res" as const,
      id: "req-1",
      ok: true as const,
      data: {
        ok: true,
        url: "https://example.com",
        status: 204,
        statusText: "No Content",
        headers: {},
        redirected: false,
      },
    }));
    const kernel = createKernel() as {
      ctx: { storage: { transactionSync: (closure: () => unknown) => unknown } };
      env: Record<string, never>;
      procs: { getIdentity: ReturnType<typeof vi.fn> };
      caps: { resolve: ReturnType<typeof vi.fn> };
      auth: { getPasswdByUid: ReturnType<typeof vi.fn> };
      devices: {
        canAccess: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
      };
      requestDevice: typeof requestDevice;
      routes: { get: ReturnType<typeof vi.fn> };
      cancelProcessRequests(
        processId: string,
        requestIds: string[],
        reason?: string,
      ): Promise<number>;
      activeRequests: Map<
        string,
        { origin: { type: "process"; id: string }; controller: AbortController }
      >;
      cancelledProcessRequests: Map<
        string,
        { expiresAt: number; reason: string }
      >;
      authorizeRegisteredProcessRuntime: ReturnType<typeof vi.fn>;
      requestProcessNetFetch(
        processId: string,
        target: string,
        args: { url: string; timeoutMs: number },
        options?: {
          ttlMs?: number;
          internalPurpose?: "model-transport";
          body?: { stream: ReadableStream<Uint8Array>; length?: number };
          requestId?: string;
        },
      ): Promise<unknown>;
    };
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.ctx = {
      storage: { transactionSync: (closure: () => unknown) => closure() },
    };
    kernel.env = {};
    kernel.procs = {
      get: vi.fn(() => ({
        ownerUid: 0,
        kernelGeneration: null,
        packageSecurityRevision: null,
      })),
      getIdentity: vi.fn(() => ({
        uid: 0,
        gid: 0,
        gids: [0],
        username: "root",
        home: "/root",
        cwd: "/root",
      })),
    };
    kernel.caps = { resolve: vi.fn(() => options.capabilities ?? ["net.fetch"]) };
    kernel.auth = { getPasswdByUid: vi.fn(() => null) };
    kernel.devices = {
      canAccess: vi.fn(() => true),
      get: vi.fn(() => device),
    };
    kernel.requestDevice = requestDevice;
    kernel.routes = { get: vi.fn(() => null) };
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
    return { kernel, requestDevice };
  }

  it("validates the process target and calls requestDevice", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000 },
    );

    expect(result).toMatchObject({ ok: true, data: { status: 204 } });
    expect(kernel.procs.getIdentity).toHaveBeenCalledWith("proc_1");
    expect(kernel.devices.canAccess).toHaveBeenCalledWith("linux-machine", 0, [0]);
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      expect.objectContaining({
        ttlMs: 180000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("requires net.fetch capability for default process net fetches", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });
    let bodyCancelled = false;

    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      {
        ttlMs: 180000,
        body: {
          stream: new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          length: 3,
        },
      },
    )).rejects.toThrow("Permission denied: net.fetch");

    expect(bodyCancelled).toBe(true);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it("allows internal model transport net fetches without tool capability", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest({ capabilities: [] });

    const result = await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000, internalPurpose: "model-transport" },
    );

    expect(result).toMatchObject({ ok: true, data: { status: 204 } });
    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      expect.objectContaining({
        ttlMs: 180000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("registers cancellable process net.fetch requests", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    await kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { ttlMs: 180000, requestId: "fetch-1" },
    );

    expect(requestDevice).toHaveBeenCalledWith(
      "linux-machine",
      "net.fetch",
      { url: "https://example.com", timeoutMs: 180000 },
      expect.objectContaining({
        ttlMs: 180000,
        id: "fetch-1",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(kernel.activeRequests.size).toBe(0);
  });

  it("only lets the owning process cancel an active request", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    const controller = new AbortController();
    kernel.activeRequests = new Map([
      ["fetch-1", { origin: { type: "process", id: "proc_1" }, controller }],
    ]);
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = { get: vi.fn(() => null) };

    expect(await kernel.cancelProcessRequests("proc_2", ["fetch-1"])).toBe(0);
    expect(controller.signal.aborted).toBe(false);
    expect(await kernel.cancelProcessRequests("proc_1", ["fetch-1"], "stopped")).toBe(1);
    expect(controller.signal.reason).toEqual(new Error("stopped"));
  });

  it("forwards routed cancellation only for the owning process", async () => {
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.activeRequests = new Map();
    kernel.cancelledProcessRequests = new Map();
    kernel.routes = {
      get: vi.fn(() => ({
        id: "search-1",
        origin: { type: "process", id: "proc_1" },
        deviceId: "device-1",
        driverConnectionId: "driver-connection",
      })),
    };
    kernel.sendDeviceRequestCancel = vi.fn();
    kernel.cancelRoute = vi.fn();

    expect(await kernel.cancelProcessRequests("proc_2", ["search-1"], "stopped")).toBe(0);
    expect(kernel.sendDeviceRequestCancel).not.toHaveBeenCalled();
    expect(await kernel.cancelProcessRequests("proc_1", ["search-1"], "stopped")).toBe(1);
    expect(kernel.sendDeviceRequestCancel).toHaveBeenCalledWith(
      "device-1",
      "driver-connection",
      "search-1",
      "stopped",
    );
    expect(kernel.cancelRoute).toHaveBeenCalledWith("search-1");
  });

  it("cancels a connection request without exposing the control signal", () => {
    const kernel = createKernel() as any;
    const controller = new AbortController();
    kernel.activeRequests = new Map([
      ["request-1", { origin: { type: "connection", id: "conn-1" }, controller }],
    ]);
    kernel.routes = { get: vi.fn(() => null) };

    kernel.handleRequestCancel(
      { id: "conn-1", state: { step: "connected" } },
      {
        type: "sig",
        signal: "request.cancel",
        payload: { id: "request-1", reason: "client timed out" },
      },
    );

    expect(controller.signal.reason).toEqual(new Error("client timed out"));
  });

  it("honors cancellation that arrives before process fetch registration", async () => {
    const { kernel, requestDevice } = buildKernelForDeviceRequest();

    expect(await kernel.cancelProcessRequests("proc_1", ["fetch-early"], "superseded")).toBe(1);
    await expect(kernel.requestProcessNetFetch(
      "proc_1",
      "linux-machine",
      { url: "https://example.com", timeoutMs: 180000 },
      { requestId: "fetch-early" },
    )).rejects.toThrow("superseded");

    expect(requestDevice).not.toHaveBeenCalled();
    expect(kernel.cancelledProcessRequests.size).toBe(0);
  });
});

describe("Kernel process runtime projection", () => {
  it("uses only installed package authority and exact-kills it under the local fence", async () => {
    sendFrameToProcessMock.mockReset();
    const owner = {
      username: "alice",
      uid: 1000,
      gid: 1000,
      gecos: "Alice",
      home: "/home/alice",
      shell: "/bin/init",
    };
    const agent = {
      username: "pkg-1111111111111111111111111111",
      uid: 2000,
      gid: 2000,
      gecos: "Builder",
      home: "/home/pkg-1111111111111111111111111111",
      shell: "/bin/init",
    };
    const oldProfile = {
      name: "builder",
      displayName: "Builder",
      capabilities: ["net.fetch"],
      contextFiles: [{ name: "00-role.md", text: "Build things." }],
    } satisfies PackageProfileManifest;
    const currentProfile = {
      ...oldProfile,
      capabilities: [],
    } satisfies PackageProfileManifest;
    const packageRecord = (
      updatedAt: number,
      profile: PackageProfileManifest,
    ): InstalledPackageRecord => ({
      packageId: "import:root/tools:.",
      scope: { kind: "global" },
      enabled: true,
      reviewRequired: false,
      reviewedAt: null,
      installedAt: 1,
      updatedAt,
      artifact: { hash: `sha256:${updatedAt}`, mainModule: "index.ts", modulePaths: [] },
      manifest: {
        name: "tools",
        description: "tools",
        version: "1.0.0",
        runtime: "dynamic-worker",
        source: { repo: "root/tools", ref: "main", subdir: "." },
        entrypoints: [],
        profiles: [profile],
      },
    });
    const oldRecord = packageRecord(1, oldProfile);
    const currentRecord = packageRecord(2, currentProfile);
    const oldRevision = await packageAgentSecurityRevision(oldRecord, oldProfile);
    const currentRevision = await packageAgentSecurityRevision(currentRecord, currentProfile);
    const stampConfig = (revision: string) => new Map<string, string>([
      [`users/${agent.uid}/pkg/owner`, oldRecord.packageId],
      [`users/${agent.uid}/pkg/scope`, "global"],
      [`users/${agent.uid}/pkg/profile`, oldProfile.name],
      [`users/${agent.uid}/pkg/human_uid`, String(owner.uid)],
      [`users/${agent.uid}/pkg/access_group`, packageAgentAccessGroup(agent.username)],
      [`users/${agent.uid}/pkg/context_files`, "[]"],
      [`users/${agent.uid}/pkg/security_revision`, revision],
    ]);
    const accountIdentity = (username: string) => username === owner.username
      ? { username, uid: owner.uid, kind: "human", state: "active" }
      : username === agent.username
        ? { username, uid: agent.uid, kind: "agent", state: "active" }
        : null;
    const auth = {
      getPasswdByUid: vi.fn((uid: number) => uid === owner.uid
        ? owner
        : uid === agent.uid
          ? agent
          : null),
      getPasswdEntries: vi.fn(() => [owner, agent]),
      getAccountIdentity: vi.fn(accountIdentity),
      getPersonalAgentUid: vi.fn(() => null),
      getGroupByGid: vi.fn(() => null),
      getGroupByName: vi.fn((name: string) => name === packageAgentAccessGroup(agent.username)
        ? { name, gid: 3000, members: [owner.username] }
        : null),
      resolveGids: vi.fn((_username: string, primaryGid: number) => [primaryGid]),
    };

    const master = createKernel() as any;
    Object.defineProperty(master, "name", { value: "singleton" });
    master.auth = auth;
    const masterConfig = stampConfig(currentRevision);
    master.config = { get: vi.fn((key: string) => masterConfig.get(key) ?? null) };
    master.packages = { get: vi.fn(() => currentRecord) };
    master.caps = { list: vi.fn(() => []) };

    const authoritativeStores = {
      auth: master.auth,
      caps: master.caps,
      config: master.config,
      packages: master.packages,
    };
    await expect(isPackageAgentRuntimeAuthorized(authoritativeStores, {
      ownerUid: owner.uid,
      runAsUid: agent.uid,
      runAsUsername: agent.username,
      packageSecurityRevision: oldRevision,
      requiredCall: "net.fetch",
    })).resolves.toBe(false);
    await expect(isPackageAgentRuntimeAuthorized(authoritativeStores, {
      ownerUid: owner.uid,
      runAsUid: agent.uid,
      runAsUsername: agent.username,
      packageSecurityRevision: null,
      requiredCall: "net.fetch",
    })).resolves.toBe(false);
    await expect(isPackageAgentRuntimeAuthorized(authoritativeStores, {
      ownerUid: owner.uid,
      runAsUid: agent.uid,
      runAsUsername: agent.username,
      packageSecurityRevision: currentRevision,
      requiredCall: "net.fetch",
    })).resolves.toBe(false);

    const masterStub = {
      setName: vi.fn(async () => {}),
      authorizePackageAgentRuntime: vi.fn(async () => false),
    };
    const waitUntil: Promise<unknown>[] = [];
    let processRecord: any = {
      processId: "proc-stale-package",
      ownerUid: owner.uid,
      uid: agent.uid,
      gid: agent.gid,
      gids: [agent.gid],
      username: agent.username,
      home: agent.home,
      cwd: agent.home,
      kernelGeneration: 4,
      packageSecurityRevision: oldRevision,
      activeRunId: null,
    };
    const kill = vi.fn(() => {
      processRecord = null;
    });
    const clearActivePid = vi.fn();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "user:alice" });
    kernel.userKernelMarker = {
      version: 1,
      kind: "user",
      username: owner.username,
      uid: owner.uid,
      generation: 4,
      lifecycle: "active",
      updatedAt: 1,
    };
    kernel.env = {
      KERNEL: {
        idFromName: vi.fn(() => "master-id"),
        get: vi.fn(() => masterStub),
      },
    };
    kernel.ctx = {
      storage: {
        get: vi.fn(async () => ({
          version: 1,
          username: owner.username,
          uid: owner.uid,
          generation: 4,
          secret: "a".repeat(64),
        })),
        transactionSync: vi.fn((closure: () => unknown) => closure()),
      },
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntil.push(promise)),
    };
    kernel.auth = auth;
    const localConfig = stampConfig(oldRevision);
    kernel.config = { get: vi.fn((key: string) => localConfig.get(key) ?? null) };
    kernel.packages = { get: vi.fn(() => oldRecord) };
    kernel.caps = {
      list: vi.fn(() => [{ gid: agent.gid, capability: "net.fetch" }]),
    };
    let localFence: { fenceId: string; kernelGeneration: number; startedAt: number } | null = null;
    kernel.projectionState = {
      installed: vi.fn(() => ({
        username: owner.username,
        uid: owner.uid,
        kernelGeneration: 4,
        revision: 1,
        digest: `sha256:${"1".repeat(64)}`,
      })),
      packageFence: vi.fn(() => localFence),
    };
    kernel.procs = {
      get: vi.fn(() => processRecord),
      kill,
    };
    kernel.activeRequests = new Map();
    kernel.revokedProcessTeardowns = new Map();
    kernel.conversations = { clearActivePid };
    kernel.runRoutes = { delete: vi.fn() };
    kernel.ipcCalls = { cancelBySourcePid: vi.fn() };
    kernel.failIpcCallsByTarget = vi.fn();
    sendFrameToProcessMock.mockImplementationOnce(async (pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "invalid",
      ok: true,
      data: { ok: true, pid },
    }));

    await expect(kernel.authorizeCurrentPackageAgentRuntime(
      owner.uid,
      {
        uid: agent.uid,
        gid: agent.gid,
        gids: [agent.gid],
        username: agent.username,
        home: agent.home,
        cwd: agent.home,
      },
      oldRevision,
      "net.fetch",
    )).resolves.toBe(true);
    expect(masterStub.authorizePackageAgentRuntime).not.toHaveBeenCalled();

    localFence = {
      fenceId: "package-fence",
      kernelGeneration: 4,
      startedAt: Date.now(),
    };
    await expect(kernel.authorizeCurrentPackageAgentRuntime(
      owner.uid,
      {
        uid: agent.uid,
        gid: agent.gid,
        gids: [agent.gid],
        username: agent.username,
        home: agent.home,
        cwd: agent.home,
      },
      oldRevision,
      "net.fetch",
      "proc-stale-package",
    )).resolves.toBe(false);
    await Promise.all(waitUntil);

    expect(masterStub.authorizePackageAgentRuntime).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc-stale-package",
      expect.objectContaining({
        call: "proc.kill",
        args: { pid: "proc-stale-package", archive: false },
      }),
    );
    expect(sendFrameToProcessMock.mock.invocationCallOrder[0])
      .toBeLessThan(kill.mock.invocationCallOrder[0]);
    expect(clearActivePid).toHaveBeenCalledWith("proc-stale-package");
    expect(processRecord).toBeNull();
  });

  it.each([
    ["missing", null],
    ["mismatched", `sha256:${"2".repeat(64)}`],
  ])("tears down a package process before installing a %s projected revision", async (
    _label,
    projectedRevision,
  ) => {
    const oldRevision = `sha256:${"1".repeat(64)}`;
    const events: string[] = [];
    const kernel = createKernel() as any;
    kernel.procs = {
      list: vi.fn(() => [{
        processId: "proc-old-revision",
        uid: 2000,
        packageSecurityRevision: oldRevision,
      }]),
    };
    kernel.schedules = { listStored: vi.fn(() => []) };
    kernel.config = {
      get: vi.fn((key: string) => key === "users/2000/pkg/owner" ? "pkg" : null),
    };
    kernel.queueRevokedProcessTeardown = vi.fn(async () => {
      events.push("teardown");
    });
    kernel.applyUserKernelProjection = vi.fn(() => {
      events.push("install");
    });
    const config = projectedRevision === null
      ? []
      : [{ key: "users/2000/pkg/security_revision", value: projectedRevision }];

    await kernel.reconcilePackageProjectionRuntime(config);
    kernel.applyUserKernelProjection();

    expect(kernel.queueRevokedProcessTeardown).toHaveBeenCalledWith(
      "proc-old-revision",
      "Package security revision changed",
    );
    expect(events).toEqual(["teardown", "install"]);
  });

  it("keeps a revoked process registered when its Process DO does not exact-ack kill", async () => {
    sendFrameToProcessMock.mockReset();
    const record = {
      processId: "proc-no-kill-ack",
      ownerUid: 1000,
      uid: 2000,
      kernelGeneration: 4,
      packageSecurityRevision: `sha256:${"1".repeat(64)}`,
      activeRunId: null,
    };
    const kill = vi.fn();
    const kernel = createKernel() as any;
    kernel.procs = { get: vi.fn(() => record), kill };
    kernel.conversations = { clearActivePid: vi.fn() };
    kernel.runRoutes = { delete: vi.fn() };
    kernel.ipcCalls = { cancelBySourcePid: vi.fn() };
    kernel.failIpcCallsByTarget = vi.fn();
    kernel.ctx = {
      storage: { transactionSync: vi.fn((closure: () => unknown) => closure()) },
    };
    sendFrameToProcessMock.mockImplementationOnce(async (_pid, frame) => ({
      type: "res",
      id: frame.type === "req" ? frame.id : "invalid",
      ok: true,
      data: { ok: true },
    }));

    await expect(kernel.teardownRevokedProcess(
      record.processId,
      "Package agent authority was revoked",
    )).rejects.toThrow("did not exact-ack teardown");

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      record.processId,
      expect.objectContaining({ call: "proc.kill" }),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(kernel.conversations.clearActivePid).not.toHaveBeenCalled();
  });

  it("waits for earlier process signals before acknowledging a run finish", async () => {
    let releaseStarted!: () => void;
    const startedBlocked = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const events: string[] = [];
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.pendingProcessSignals = new Map();
    kernel.extractRunId = vi.fn((payload) => payload.runId);
    kernel.updateProcessRuntimeFromSignal = vi.fn(() => true);
    kernel.completeIpcCallsForProcessSignal = vi.fn();
    kernel.authorizeRegisteredProcessRuntime = vi.fn(async () => true);
    kernel.procs = {
      get: vi.fn(() => ({
        ownerUid: 0,
        kernelGeneration: null,
        packageSecurityRevision: null,
      })),
    };
    kernel.handleProcessSignal = vi.fn(async (_pid: string, frame: { signal: string }) => {
      events.push(`${frame.signal}:start`);
      if (frame.signal === "proc.run.started") {
        await startedBlocked;
      }
      events.push(`${frame.signal}:done`);
    });

    await kernel.recvFrame("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-1" },
    });
    await vi.waitFor(() => expect(events).toEqual(["proc.run.started:start"]));

    let finishAcknowledged = false;
    const finishing = kernel.recvFrame("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-1" },
    }).then(() => {
      finishAcknowledged = true;
    });
    await Promise.resolve();
    expect(finishAcknowledged).toBe(false);

    releaseStarted();
    await finishing;
    expect(events).toEqual([
      "proc.run.started:start",
      "proc.run.started:done",
      "proc.run.finished:start",
      "proc.run.finished:done",
    ]);
  });

  it("accepts a newer successor start and rejects an older reordered start", () => {
    const record = { activeRunId: "run-old", lastActiveAt: 100 };
    const updateRuntimeState = vi.fn((_pid: string, patch: Record<string, unknown>) => {
      Object.assign(record, patch);
    });
    const kernel = createKernel() as any;
    kernel.procs = {
      get: vi.fn(() => record),
      updateRuntimeState,
    };

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-new", conversationId: "default", timestamp: 200 },
    }, "run-new")).toBe(true);
    expect(record).toMatchObject({ activeRunId: "run-new", lastActiveAt: 200 });

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", conversationId: "default", timestamp: 150 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-old", conversationId: "default", timestamp: 250 },
    }, "run-old")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.output",
      payload: { runId: "run-old", conversationId: "default", timestamp: 300 },
    }, "run-old")).toBe(false);

    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.finished",
      payload: { runId: "run-new", conversationId: "default", timestamp: 400 },
    }, "run-new")).toBe(true);
    expect(kernel.updateProcessRuntimeFromSignal("proc-1", {
      type: "sig",
      signal: "proc.run.started",
      payload: { runId: "run-old", conversationId: "default", timestamp: 350 },
    }, "run-old")).toBe(false);

    expect(updateRuntimeState).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({ activeRunId: null, lastActiveAt: 400 });
  });
});

describe("Kernel IPC completion", () => {
  beforeEach(() => {
    sendFrameToProcessMock.mockReset();
  });

  it("schedules timeout callbacks no earlier than their deadline", async () => {
    const kernel = createKernel() as any;
    kernel.schedule = vi.fn(async () => ({ id: "ipc-timeout" }));
    const deadlineAt = Date.now() + 1_250;

    await kernel.scheduleIpcCallTimeout("call-timeout", deadlineAt);

    const scheduledAt = kernel.schedule.mock.calls[0]?.[0];
    expect(scheduledAt).toBeInstanceOf(Date);
    expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(deadlineAt);
    expect(kernel.schedule).toHaveBeenCalledWith(
      scheduledAt,
      "onIpcCallTimeout",
      "call-timeout",
    );
  });

  it("cancels pending calls owned by an aborted source run", async () => {
    const cancelBySourceRun = vi.fn();
    const completeByRun = vi.fn(() => []);
    const kernel = createKernel() as any;
    kernel.procs = { getOwnerUid: vi.fn(() => 1000) };
    kernel.ipcCalls = { cancelBySourceRun, completeByRun };

    await kernel.completeIpcCallsForProcessSignal("proc-source", {
      type: "sig",
      signal: "proc.run.finished",
      payload: {
        runId: "run-source",
        status: "aborted",
        reason: "user.superseded",
      },
    });

    expect(cancelBySourceRun).toHaveBeenCalledWith({
      uid: 1000,
      sourcePid: "proc-source",
      sourceRunId: "run-source",
    });
    expect(cancelBySourceRun.mock.invocationCallOrder[0]).toBeLessThan(
      completeByRun.mock.invocationCallOrder[0],
    );
  });

  it.each(["ipc.reply", "ipc.timeout"] as const)(
    "includes source-run correlation in %s payloads",
    async (signal) => {
      sendFrameToProcessMock.mockResolvedValue(null);
      const kernel = createKernel() as any;
      const call = {
        callId: "call-1",
        sourcePid: "proc-source",
        sourceRunId: "run-source",
        targetPid: "proc-target",
        targetRunId: "run-target",
        status: signal === "ipc.reply" ? "completed" : "timed_out",
        deadlineAt: 1234,
        createdAt: 1000,
        response: signal === "ipc.reply" ? { text: "done" } : null,
        error: signal === "ipc.timeout" ? "IPC call timed out" : null,
      };

      await kernel.deliverIpcCallSignal(call);

      expect(sendFrameToProcessMock).toHaveBeenCalledWith("proc-source", {
        type: "sig",
        signal,
        payload: {
          callId: "call-1",
          sourcePid: "proc-source",
          sourceRunId: "run-source",
          targetPid: "proc-target",
          runId: "run-target",
          deadlineAt: 1234,
          createdAt: 1000,
          status: call.status,
          ...(signal === "ipc.reply" ? { response: call.response } : {}),
          ...(call.error ? { error: call.error } : {}),
        },
      });
    },
  );

  it("releases failed outbox deliveries and durably requeues them", async () => {
    const call = {
      callId: "call-retry",
      sourcePid: "proc-source",
      sourceRunId: "run-source",
      targetPid: "proc-target",
      targetRunId: "run-target",
      status: "completed",
      deadlineAt: 1234,
      createdAt: 1000,
      response: { text: "done" },
      error: null,
    };
    const releaseDelivery = vi.fn();
    const remove = vi.fn();
    const kernel = createKernel() as any;
    Object.defineProperty(kernel, "name", { value: "singleton" });
    kernel.ipcCalls = {
      claimDelivery: vi.fn(() => call),
      releaseDelivery,
      remove,
    };
    kernel.schedule = vi.fn(async () => ({ id: "ipc-delivery-retry" }));
    sendFrameToProcessMock.mockRejectedValue(new Error("source unavailable"));

    await kernel.deliverIpcCall(call.callId);

    expect(releaseDelivery).toHaveBeenCalledWith(call.callId);
    expect(remove).not.toHaveBeenCalled();
    expect(kernel.schedule).toHaveBeenCalledWith(
      5,
      "onIpcCallDelivery",
      call.callId,
      {
        idempotent: false,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
  });

  it("queues terminal IPC delivery as an idempotent retrying job", () => {
    const kernel = createKernel() as any;
    kernel.ctx = { waitUntil: vi.fn() };
    kernel.schedule = vi.fn(async () => ({ id: "ipc-delivery" }));

    kernel.queueIpcCallDelivery("call-queued");

    expect(kernel.schedule).toHaveBeenCalledWith(
      expect.any(Date),
      "onIpcCallDelivery",
      "call-queued",
      {
        idempotent: true,
        retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
      },
    );
    expect(kernel.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
