import { describe, expect, it, vi } from "vitest";
import {
  buildAppDataRunnerName,
  buildAppRunnerName,
} from "../protocol/app-session";
import { trackAppRunnerResponseOperation } from "../app-runner";
import {
  APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY,
  APP_RUNNER_RUNTIME_EPOCH_KEY,
  AppRunnerPackageRuntimeFenceGate,
  type AppRunnerPackageRuntimeFenceInput,
} from "./package-runtime-fence";

class MemoryFenceStorage {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }
}

function fenceInput(
  patch: Partial<AppRunnerPackageRuntimeFenceInput> = {},
): AppRunnerPackageRuntimeFenceInput {
  return {
    authorization: crypto.randomUUID(),
    fenceKind: "package-projection",
    sourceKernelName: "user:alice",
    runnerName: buildAppRunnerName(1000, 1000, "pkg-chat"),
    ownerUid: 1000,
    ownerUsername: "alice",
    kernelOwnerUid: 1000,
    kernelOwnerUsername: "alice",
    packageId: "pkg-chat",
    generation: 3,
    fenceId: crypto.randomUUID(),
    ...patch,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("operation did not settle before the test deadline")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("AppRunner package runtime fence", () => {
  it("persists closed admission across restart without persisting the token", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const authorize = vi.fn(async () => true);
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 1_000);

    await expect(gate.prepare(input, authorize)).resolves.toMatchObject({
      runnerName: input.runnerName,
      ownerUid: 1000,
      ownerUsername: "alice",
      packageId: "pkg-chat",
      generation: 3,
      fenceId: input.fenceId,
      state: "fenced",
    });
    expect(authorize).toHaveBeenCalledWith({ ...input, action: "prepare" });
    expect(JSON.stringify(storage.values.get(APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY)))
      .not.toContain(input.authorization);

    const restarted = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 1_001);
    expect(restarted.isAdmissionClosed()).toBe(true);
    expect(() => restarted.acquireOperation()).toThrow("Package runtime authority is fenced");

    const onClear = vi.fn();
    await expect(restarted.clear(
      { ...input, authorization: crypto.randomUUID() },
      async () => true,
      onClear,
    )).resolves.toMatchObject({ state: "cleared", fenceId: input.fenceId });
    expect(onClear).toHaveBeenCalledOnce();
    const afterClear = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 1_002);
    const operation = afterClear.acquireOperation();
    operation.assertCurrent();
    operation.release();
  });

  it("aborts admitted work and waits for its exact drain before acknowledging", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 2_000);
    const operation = gate.acquireOperation();
    let acknowledged = false;

    const preparing = gate.prepare(input, async () => true).then((ack) => {
      acknowledged = true;
      return ack;
    });
    await vi.waitFor(() => expect(operation.signal.aborted).toBe(true));
    expect(acknowledged).toBe(false);
    expect(() => operation.assertCurrent()).toThrow("Package runtime authority is fenced");

    operation.release();
    await expect(preparing).resolves.toMatchObject({ state: "fenced" });
    expect(acknowledged).toBe(true);
  });

  it("abandons a never-settling opaque call and returns an exact bounded prepare ack", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput({ fenceKind: "user-lifecycle" });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 2_100);
    const operation = gate.acquireOperation();
    const opaqueCall = Promise.withResolvers<never>();
    const running = (async () => {
      try {
        return await operation.waitForOpaqueCall(() => opaqueCall.promise);
      } finally {
        operation.release();
      }
    })();
    const runningExpectation = expect(running).rejects.toThrow(
      "Package runtime authority is fenced",
    );

    const ack = await within(gate.prepare(input, async () => true));

    expect(ack).toEqual({
      fenceKind: input.fenceKind,
      sourceKernelName: input.sourceKernelName,
      runnerName: input.runnerName,
      ownerUid: input.ownerUid,
      ownerUsername: input.ownerUsername,
      kernelOwnerUid: input.kernelOwnerUid,
      kernelOwnerUsername: input.kernelOwnerUsername,
      packageId: input.packageId,
      generation: input.generation,
      fenceId: input.fenceId,
      state: "fenced",
    });
    await runningExpectation;
  });

  it("rejects an old opaque call's late effect after the exact fence is cleared", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 2_200);
    const operation = gate.acquireOperation();
    const revokedEpoch = operation.runtimeEpoch;
    const opaqueCall = Promise.withResolvers<void>();
    const lateAttempt = vi.fn();
    const lateEffect = vi.fn();
    const running = (async () => {
      try {
        return await operation.waitForOpaqueCall(async () => {
          await opaqueCall.promise;
          lateAttempt();
          const lateOperation = gate.acquireOperation(revokedEpoch);
          try {
            lateOperation.assertCurrent();
            lateEffect();
          } finally {
            lateOperation.release();
          }
        });
      } finally {
        operation.release();
      }
    })();
    const runningExpectation = expect(running).rejects.toThrow(
      "Package runtime authority is fenced",
    );

    await within(gate.prepare(input, async () => true));
    await runningExpectation;
    await gate.clear(
      { ...input, authorization: crypto.randomUUID() },
      async () => true,
    );
    const current = gate.acquireOperation();
    expect(current.runtimeEpoch).toBeGreaterThan(revokedEpoch);
    current.release();

    opaqueCall.resolve();
    await vi.waitFor(() => expect(lateAttempt).toHaveBeenCalledOnce());

    expect(lateEffect).not.toHaveBeenCalled();
  });

  it("persists a never-reused runtime epoch across clear, re-fence, and restart", async () => {
    const storage = new MemoryFenceStorage();
    const firstInput = fenceInput();
    const first = new AppRunnerPackageRuntimeFenceGate(storage, firstInput.runnerName, () => 2_300);
    const initial = first.acquireOperation();
    const initialEpoch = initial.runtimeEpoch;
    initial.release();

    await first.prepare(firstInput, async () => true);
    await first.clear(
      { ...firstInput, authorization: crypto.randomUUID() },
      async () => true,
    );
    const afterFirstClear = first.acquireOperation();
    const secondEpoch = afterFirstClear.runtimeEpoch;
    afterFirstClear.release();
    expect(secondEpoch).toBe(initialEpoch + 1);

    const secondInput = fenceInput({ fenceId: crypto.randomUUID() });
    await first.prepare(secondInput, async () => true);
    await first.clear(
      { ...secondInput, authorization: crypto.randomUUID() },
      async () => true,
    );
    const restarted = new AppRunnerPackageRuntimeFenceGate(
      storage,
      firstInput.runnerName,
      () => 2_301,
    );
    expect(() => restarted.acquireOperation(initialEpoch))
      .toThrow("AppRunner runtime epoch is stale");
    expect(() => restarted.acquireOperation(secondEpoch))
      .toThrow("AppRunner runtime epoch is stale");
    const current = restarted.acquireOperation();
    expect(current.runtimeEpoch).toBe(secondEpoch + 1);
    current.release();
    expect(storage.values.get(APP_RUNNER_RUNTIME_EPOCH_KEY)).toEqual({
      version: 1,
      runtimeEpoch: secondEpoch + 1,
    });
  });

  it("does not execute SQL after a fence lands during its authority await", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput({
      runnerName: buildAppDataRunnerName(1000, 1000, "pkg-chat"),
    });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 3_000);
    const authority = Promise.withResolvers<void>();
    const sqlExec = vi.fn();
    const operation = gate.acquireOperation();
    const sql = (async () => {
      try {
        await authority.promise;
        operation.assertCurrent();
        sqlExec();
      } finally {
        operation.release();
      }
    })();

    const preparing = gate.prepare(input, async () => true);
    await vi.waitFor(() => expect(operation.signal.aborted).toBe(true));
    authority.resolve();

    await expect(sql).rejects.toThrow("Package runtime authority is fenced");
    expect(sqlExec).not.toHaveBeenCalled();
    await expect(preparing).resolves.toMatchObject({ state: "fenced" });
  });

  it("cancels a dynamic response stream before acknowledging its drain", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput({ fenceKind: "user-lifecycle" });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 3_100);
    const operation = gate.acquireOperation();
    const events: string[] = [];
    const cancel = vi.fn(() => {
      events.push("cancel");
    });
    const tracked = trackAppRunnerResponseOperation(new Response(new ReadableStream({
      cancel,
    })), operation);
    const preparing = gate.prepare(input, async () => true).then((ack) => {
      events.push("ack");
      return ack;
    });
    await expect(preparing).resolves.toMatchObject({ state: "fenced" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(events).toEqual(["cancel", "ack"]);
    await tracked.body?.cancel().catch(() => {});
  });

  it("keeps admission closed when clear cleanup fails", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 4_000);
    await gate.prepare(input, async () => true);

    await expect(gate.clear(
      { ...input, authorization: crypto.randomUUID() },
      async () => true,
      async () => {
        throw new Error("alarm reconciliation failed");
      },
    )).rejects.toThrow("alarm reconciliation failed");

    expect(gate.isAdmissionClosed()).toBe(true);
    const restarted = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 4_001);
    expect(restarted.isAdmissionClosed()).toBe(true);
  });

  it("can safely re-fence the same tuple after a lost clear acknowledgment", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const first = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 5_000);
    await first.prepare(input, async () => true);
    await first.clear(
      { ...input, authorization: crypto.randomUUID() },
      async () => true,
    );

    const recovering = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 5_001);
    expect(recovering.isAdmissionClosed()).toBe(false);
    await expect(recovering.prepare(
      { ...input, authorization: crypto.randomUUID() },
      async () => true,
    )).resolves.toMatchObject({ state: "fenced", fenceId: input.fenceId });

    const restarted = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 5_002);
    expect(restarted.isAdmissionClosed()).toBe(true);
  });

  it("accepts explicit legacy Master authorization but rejects a mismatched user Kernel", async () => {
    const storage = new MemoryFenceStorage();
    const legacy = fenceInput({
      sourceKernelName: "singleton",
    });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, legacy.runnerName, () => 6_000);

    await expect(gate.prepare(legacy, async () => true))
      .resolves.toMatchObject({ sourceKernelName: "singleton", state: "fenced" });

    const otherStorage = new MemoryFenceStorage();
    const mismatched = fenceInput({ sourceKernelName: "user:bob" });
    const otherGate = new AppRunnerPackageRuntimeFenceGate(
      otherStorage,
      mismatched.runnerName,
      () => 6_001,
    );
    const authorize = vi.fn(async () => true);
    await expect(otherGate.prepare(mismatched, authorize))
      .rejects.toThrow("AppRunner package fence input is invalid");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects a fence whose Kernel owner does not match the physical runner", async () => {
    const storage = new MemoryFenceStorage();
    const aliceRunnerName = buildAppRunnerName(1000, 0, "pkg-chat");
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, aliceRunnerName);
    const authorize = vi.fn(async () => true);

    await expect(gate.prepare(fenceInput({
      sourceKernelName: "user:bob",
      runnerName: aliceRunnerName,
      ownerUid: 0,
      ownerUsername: "root",
      kernelOwnerUid: 1001,
      kernelOwnerUsername: "bob",
    }), authorize)).rejects.toThrow("AppRunner package fence input is invalid");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("keeps legacy lifecycle prepare and clear on the exact Master source", async () => {
    const storage = new MemoryFenceStorage();
    const legacy = fenceInput({
      fenceKind: "user-lifecycle",
      sourceKernelName: "singleton",
    });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, legacy.runnerName, () => 6_100);
    await gate.prepare(legacy, async () => true);

    const authorization = vi.fn(async () => true);
    await expect(gate.clear({
      ...legacy,
      authorization: crypto.randomUUID(),
    }, authorization)).resolves.toMatchObject({
      fenceKind: "user-lifecycle",
      sourceKernelName: "singleton",
      state: "cleared",
    });
    expect(authorization).toHaveBeenCalledWith(expect.objectContaining({
      action: "clear",
      sourceKernelName: "singleton",
      generation: legacy.generation,
      fenceId: legacy.fenceId,
    }));
  });

  it("does not let a package clear release a lifecycle fence with the same id", async () => {
    const storage = new MemoryFenceStorage();
    const lifecycle = fenceInput({ fenceKind: "user-lifecycle" });
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, lifecycle.runnerName, () => 6_200);
    const operation = gate.acquireOperation();
    const preparing = gate.prepare(lifecycle, async () => true);
    await vi.waitFor(() => expect(operation.signal.aborted).toBe(true));
    operation.release();
    await preparing;

    await expect(gate.clear({
      ...lifecycle,
      authorization: crypto.randomUUID(),
      fenceKind: "package-projection",
    }, async () => true)).rejects.toThrow("does not match the active fence");
    expect(gate.isAdmissionClosed()).toBe(true);
  });

  it("rejects a non-exact clear and leaves the original fence durable", async () => {
    const storage = new MemoryFenceStorage();
    const input = fenceInput();
    const gate = new AppRunnerPackageRuntimeFenceGate(storage, input.runnerName, () => 7_000);
    await gate.prepare(input, async () => true);

    await expect(gate.clear(
      {
        ...input,
        authorization: crypto.randomUUID(),
        fenceId: crypto.randomUUID(),
      },
      async () => true,
    )).rejects.toThrow("does not match the active fence");
    expect(gate.isAdmissionClosed()).toBe(true);
  });

  it("fails closed on malformed durable state", () => {
    const storage = new MemoryFenceStorage();
    const runnerName = buildAppRunnerName(1000, 1000, "pkg-chat");
    storage.values.set(APP_RUNNER_PACKAGE_RUNTIME_FENCE_KEY, {
      version: 1,
      state: "cleared",
      runnerName,
    });

    const gate = new AppRunnerPackageRuntimeFenceGate(storage, runnerName);
    expect(gate.isAdmissionClosed()).toBe(true);
    expect(() => gate.acquireOperation()).toThrow("fence state is invalid");
  });
});
