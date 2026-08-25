import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { IpcCallStore } from "./ipc-calls";

describe("IpcCallStore", () => {
  it("stores run correlation atomically and cancels pending calls by source run", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
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
      expect(calls.findPendingByTargetRun({
        uid: 1000,
        targetPid: "proc-target",
        targetRunId: "run-target",
      })).toMatchObject({
        callId,
        sourcePid: "proc-source",
        sourceRunId: "run-source",
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
      expect(calls.findPendingByTargetRun({
        uid: 1000,
        targetPid: "proc-target",
        targetRunId: "run-target",
      })).toBeNull();
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
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
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
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
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

  it("persists the owner and delegated responsibility through completion", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
      const responsibilityId = "r12y:11111111-1111-4111-8111-111111111111";
      calls.create({
        callId: "ipc:linked-call",
        uid: 1000,
        sourcePid: "proc:ship",
        sourceRunId: "run:ship",
        targetPid: "proc:worker",
        targetRunId: "run:worker",
        deadlineAt: Date.now() + 60_000,
        responsibilityId,
      });

      expect(calls.get("ipc:linked-call")).toMatchObject({
        ownerUid: 1000,
        responsibilityId,
        status: "pending",
      });
      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc:worker",
        runId: "run:worker",
        response: { text: "done" },
      })).toEqual(["ipc:linked-call"]);
      expect(calls.get("ipc:linked-call")).toMatchObject({
        ownerUid: 1000,
        responsibilityId,
        status: "completed",
        response: { text: "done" },
      });
    });
  });
});
