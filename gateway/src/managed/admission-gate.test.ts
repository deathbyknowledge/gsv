import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MANAGED_ADMISSION_GATE_NAME,
  describeManagedAdmissionObjects,
  runWithManagedAdmission,
} from "../../../adapters/shared/src/managed-admission";

describe("managed adapter admission gate", () => {
  it("fences before draining and rejects a continuation from the old epoch", async () => {
    const gate = env.TEST_MANAGED_ADMISSION.getByName("drain-and-stale");
    const lease = await gate.acquire("test:operation");
    expect(lease.admitted).toBe(true);
    if (!lease.admitted) throw new Error("expected admission");

    const fence = gate.managedFenceAll(500);
    await expect(gate.acquire("test:new-operation")).resolves.toMatchObject({
      admitted: false,
      status: "fenced",
    });
    await expect(gate.assertCurrent(lease.leaseId, lease.epoch)).resolves.toBe(false);
    await gate.release(lease.leaseId);
    await expect(fence).resolves.toMatchObject({ status: "fenced", epoch: 1 });
  });

  it("expires a crashed owner without opening the failed fence", async () => {
    const gate = env.TEST_MANAGED_ADMISSION.getByName("crashed-owner");
    const lease = await gate.acquire("test:crashed");
    expect(lease.admitted).toBe(true);

    await expect(gate.managedFenceAll(20)).resolves.toMatchObject({
      status: "fenced",
      drained: false,
    });
    await expect(gate.acquire("test:still-closed")).resolves.toMatchObject({
      admitted: false,
      status: "fenced",
    });

    await delay(240);
    await expect(gate.managedFenceAll(500)).resolves.toMatchObject({
      status: "fenced",
    });
  });

  it("heartbeats a long operation and retains its lease during fencing", async () => {
    const gate = env.TEST_MANAGED_ADMISSION.getByName(MANAGED_ADMISSION_GATE_NAME);
    let finishOperation = (): void => {};
    const operation = runWithManagedAdmission(
      env.TEST_MANAGED_ADMISSION,
      "test:long-operation",
      () => new Promise<string>((resolve) => {
        finishOperation = () => resolve("done");
      }),
      { heartbeatMs: 40 },
    );

    await delay(280);
    await expect(gate.managedFenceAll(20)).resolves.toMatchObject({
      status: "fenced",
      drained: false,
    });
    finishOperation();
    await expect(operation).rejects.toThrow(/fenced/);
    await expect(gate.managedFenceAll(500)).resolves.toMatchObject({ status: "fenced" });
  });

  it("increments durable epochs across fence and resume", async () => {
    const gate = env.TEST_MANAGED_ADMISSION.getByName(MANAGED_ADMISSION_GATE_NAME);
    await expect(gate.managedFenceAll()).resolves.toMatchObject({
      status: "fenced",
      epoch: 1,
    });
    await expect(gate.managedResumeAll()).resolves.toMatchObject({
      status: "active",
      epoch: 2,
    });
    await expect(gate.managedDescriptor()).resolves.toMatchObject({
      schemaVersion: 1,
      kind: "adapter_admission",
      classification: "initialized",
      lifecycle: { status: "active", epoch: 2 },
    });
  });

  it("keeps erase idempotent while remaining permanently closed", async () => {
    const gate = env.TEST_MANAGED_ADMISSION.getByName(MANAGED_ADMISSION_GATE_NAME);
    const first = await gate.managedEraseAll();
    const second = await gate.managedEraseAll();
    expect(first).toMatchObject({ status: "erased", drained: true });
    expect(second).toEqual(first);
    await expect(gate.acquire("test:after-erase")).resolves.toMatchObject({
      admitted: false,
      status: "erased",
    });
  });

  it("describes the singleton and arbitrary provider IDs exactly", async () => {
    const singletonId = env.MANAGED_ADMISSION
      .idFromName(MANAGED_ADMISSION_GATE_NAME)
      .toString();
    const unknownId = env.MANAGED_ADMISSION.newUniqueId().toString();

    await expect(describeManagedAdmissionObjects(
      env.MANAGED_ADMISSION,
      [singletonId],
    )).resolves.toMatchObject({
      kind: "adapter_admission",
      objects: [{
        providerId: singletonId,
        logicalName: MANAGED_ADMISSION_GATE_NAME,
        classification: "erased",
        lifecycle: { status: "erased", epoch: expect.any(Number) },
      }],
    });
    await expect(describeManagedAdmissionObjects(
      env.MANAGED_ADMISSION,
      [unknownId],
    )).resolves.toMatchObject({
      objects: [{
        providerId: unknownId,
        logicalName: null,
        classification: "uninitialized",
      }],
    });
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
