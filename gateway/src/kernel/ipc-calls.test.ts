import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { Kernel } from "./do";
import type { IpcCallStore } from "./ipc-calls";

describe("IpcCallStore", () => {
  it("stores run correlation atomically and cancels pending calls by source run", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      const calls = (instance as unknown as { ipcCalls: IpcCallStore }).ipcCalls;
      const callId = crypto.randomUUID();
      calls.create({
        callId,
        uid: 1000,
        sourcePid: "proc-source",
        sourceRunId: "run-source",
        targetPid: "proc-target",
        targetRunId: "run-target",
        deadlineAt: Date.now() + 60_000,
      });

      expect(calls.get(callId)).toMatchObject({
        sourceRunId: "run-source",
        targetRunId: "run-target",
        status: "pending",
      });
      calls.cancelBySourceRun({
        uid: 1000,
        sourcePid: "proc-source",
        sourceRunId: "another-run",
      });
      expect(calls.get(callId)?.status).toBe("pending");
      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc-target",
        runId: "run-target",
        response: { text: "completed before cancellation" },
      })).toHaveLength(1);
      calls.cancelBySourceRun({
        uid: 1000,
        sourcePid: "proc-source",
        sourceRunId: "run-source",
      });
      expect(calls.get(callId)).toBeNull();
      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc-target",
        runId: "run-target",
        response: { text: "late result" },
      })).toEqual([]);
    });
  });

  it("allows calls made outside an active source run", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      const calls = (instance as unknown as { ipcCalls: IpcCallStore }).ipcCalls;
      const callId = crypto.randomUUID();

      calls.create({
        callId,
        uid: 1000,
        sourcePid: "proc-source",
        sourceRunId: null,
        targetPid: "proc-target",
        targetRunId: "run-target",
        deadlineAt: Date.now() + 60_000,
      });

      expect(calls.get(callId)?.sourceRunId).toBeNull();
      calls.cancelBySourcePid({ uid: 1000, sourcePid: "proc-source" });
      expect(calls.get(callId)).toBeNull();
    });
  });

  it("fails pending calls when their target process is killed", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    await runInDurableObject(kernel, (instance: Kernel) => {
      const calls = (instance as unknown as { ipcCalls: IpcCallStore }).ipcCalls;
      const callId = crypto.randomUUID();
      calls.create({
        callId,
        uid: 1000,
        sourcePid: "proc-source",
        sourceRunId: "run-source",
        targetPid: "proc-target",
        targetRunId: "run-target",
        deadlineAt: Date.now() + 60_000,
      });

      expect(calls.failByTargetPid({
        uid: 1000,
        targetPid: "proc-target",
        error: "Target process was killed",
      })).toEqual([callId]);
      expect(calls.get(callId)).toMatchObject({
        status: "completed",
        response: null,
        error: "Target process was killed",
      });
    });
  });
});
