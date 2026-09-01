import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { IpcCallStore } from "./ipc-calls";
import {
  KERNEL_V036_SUPERVISE_DELEGATED_IPC_CALLS,
} from "./schema/v036_supervise_delegated_ipc_calls";

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
        supervised: false,
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

  it("renews a pending supervision deadline without losing its eventual result", async () => {
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
        deadlineAt: Date.now() - 1,
      });

      const nextDeadlineAt = Date.now() + 60_000;
      expect(calls.renewDeadline(callId, nextDeadlineAt)).toMatchObject({
        callId,
        status: "pending",
        supervised: true,
        deadlineAt: nextDeadlineAt,
      });
      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc-target",
        runId: "run-target",
        response: { text: "finished after the first check-in" },
      })).toEqual([callId]);
    });
  });

  it("backfills only in-flight legacy delegations as supervised", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
      const delegatedCallId = crypto.randomUUID();
      const ordinaryCallId = crypto.randomUUID();
      for (const callId of [delegatedCallId, ordinaryCallId]) {
        calls.create({
          callId,
          uid: 1000,
          sourcePid: "proc-source",
          sourceRunId: "run-source",
          targetPid: `proc-target-${callId}`,
          targetRunId: `run-target-${callId}`,
          deadlineAt: Date.now() - 1,
        });
      }
      sql.exec(
        `INSERT INTO cf_agents_schedules (
          id, callback, payload, type, time, owner_path, owner_path_key
        ) VALUES (?, 'onIpcCallTimeout', ?, 'scheduled', ?, NULL, NULL)`,
        crypto.randomUUID(),
        JSON.stringify({
          callId: delegatedCallId,
          terminateTargetOnTimeout: true,
        }),
        Math.floor(Date.now() / 1_000),
      );

      sql.exec(KERNEL_V036_SUPERVISE_DELEGATED_IPC_CALLS.statements[1]!);

      expect(calls.get(delegatedCallId)?.supervised).toBe(true);
      expect(calls.get(ordinaryCallId)?.supervised).toBe(false);
      expect(calls.completeByRun({
        uid: 1000,
        targetPid: `proc-target-${delegatedCallId}`,
        runId: `run-target-${delegatedCallId}`,
        response: { text: "legacy delegation finished during upgrade" },
      })).toEqual([delegatedCallId]);
    });
  });

  it("preserves the exact deadline for an ordinary IPC call", async () => {
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
        deadlineAt: Date.now() - 1,
      });

      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc-target",
        runId: "run-target",
        response: { text: "late result" },
      })).toEqual([]);
      expect(calls.get(callId)).toMatchObject({
        status: "pending",
        supervised: false,
      });
    });
  });

  it("accepts a supervised result while its checkpoint is being renewed", async () => {
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
        deadlineAt: Date.now() - 1,
        supervised: true,
      });

      expect(calls.completeByRun({
        uid: 1000,
        targetPid: "proc-target",
        runId: "run-target",
        response: { text: "eventual result" },
      })).toEqual([callId]);
      expect(calls.get(callId)).toMatchObject({
        status: "completed",
        supervised: true,
      });
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
      calls.cancelBySourceRun({
        uid: 1000,
        sourcePid: "proc:ship",
        sourceRunId: "run:ship",
      });
      calls.cancelBySourcePid({ uid: 1000, sourcePid: "proc:ship" });
      expect(calls.get("ipc:linked-call")).toMatchObject({
        responsibilityId,
        status: "completed",
      });
    });
  });
});
