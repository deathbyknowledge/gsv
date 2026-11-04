import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { IpcCallStore } from "./ipc-calls";

const RESPONSIBILITY = "r12y:11111111-1111-4111-8111-111111111111";

function callTo(calls: IpcCallStore, targetPid: string, options: { deadlineAt?: number; supervised?: boolean; responsibilityId?: string } = {}) {
  const callId = crypto.randomUUID();
  calls.create({
    callId, uid: 1000, sourcePid: "proc:ship", sourceRunId: "run:ship",
    targetPid, targetRunId: `run:${targetPid}`, deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
    ...(options.supervised ? { supervised: true } : undefined),
    ...(options.responsibilityId ? { responsibilityId: options.responsibilityId } : undefined),
  });
  return callId;
}

describe("IpcCallStore", () => {
  it("keeps a call only while it is in flight: its run, its target or its deadline ends it and returns it", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
      const answered = callTo(calls, "proc:answers", { responsibilityId: RESPONSIBILITY });
      const reset = callTo(calls, "proc:reset");
      const overdue = callTo(calls, "proc:slow", { deadlineAt: Date.now() + 1_000 });

      expect(calls.findPendingByTargetRun({ uid: 1000, targetPid: "proc:answers", targetRunId: "run:proc:answers" })).toEqual({
        callId: answered, ownerUid: 1000, sourcePid: "proc:ship", sourceRunId: "run:ship", targetPid: "proc:answers",
        targetRunId: "run:proc:answers", supervised: false, deadlineAt: expect.any(Number), createdAt: expect.any(Number),
        responsibilityId: RESPONSIBILITY,
      });
      expect(calls.endByRun({ uid: 1000, targetPid: "proc:answers", runId: "run:proc:answers" }))
        .toEqual([expect.objectContaining({ callId: answered, responsibilityId: RESPONSIBILITY })]);
      expect(calls.endByTarget({ uid: 1000, targetPid: "proc:reset" })).toEqual([expect.objectContaining({ callId: reset })]);
      expect(calls.endOverdue(overdue)).toBeNull();
      expect(calls.endOverdue(overdue, Date.now() + 1_000)).toMatchObject({ callId: overdue });

      for (const callId of [answered, reset, overdue]) expect(calls.get(callId)).toBeNull();
      expect(calls.endByRun({ uid: 1000, targetPid: "proc:answers", runId: "run:proc:answers" })).toEqual([]);
    });
  });

  it("leaves an unsupervised call past its deadline to its timeout, and lets a supervised call's run end it at any time", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
      const late = callTo(calls, "proc:late", { deadlineAt: Date.now() - 1 });
      const supervised = callTo(calls, "proc:supervised", { deadlineAt: Date.now() - 1, supervised: true });
      const renewed = callTo(calls, "proc:renewed", { deadlineAt: Date.now() - 1 });

      expect(calls.endByRun({ uid: 1000, targetPid: "proc:late", runId: "run:proc:late" })).toEqual([]);
      expect(calls.get(late)).toMatchObject({ supervised: false });
      expect(calls.endByRun({ uid: 1000, targetPid: "proc:supervised", runId: "run:proc:supervised" }))
        .toEqual([expect.objectContaining({ callId: supervised })]);
      // A check-in renews the deadline and supervises the call from then on.
      const nextDeadlineAt = Date.now() + 60_000;
      expect(calls.renewDeadline(renewed, nextDeadlineAt)).toMatchObject({ callId: renewed, supervised: true, deadlineAt: nextDeadlineAt });
      expect(calls.endByRun({ uid: 1000, targetPid: "proc:renewed", runId: "run:proc:renewed" }))
        .toEqual([expect.objectContaining({ callId: renewed })]);
    });
  });

  it("cancels a caller's calls by run or by process, keeping the ones that carry delegated work", async () => {
    await runWithRealKernelSql((sql) => {
      const calls = new IpcCallStore(sql);
      const first = callTo(calls, "proc:one");
      const second = callTo(calls, "proc:two");
      const delegated = callTo(calls, "proc:three", { responsibilityId: RESPONSIBILITY });
      calls.create({
        callId: "outside-a-run", uid: 1000, sourcePid: "proc:ship", sourceRunId: null,
        targetPid: "proc:four", targetRunId: "run:proc:four", deadlineAt: Date.now() + 60_000,
      });

      calls.cancelBySourceRun({ uid: 1000, sourcePid: "proc:ship", sourceRunId: "another-run" });
      expect(calls.get(first)).not.toBeNull();
      calls.cancelBySourceRun({ uid: 1000, sourcePid: "proc:ship", sourceRunId: "run:ship" });
      expect(calls.get(first)).toBeNull();
      expect(calls.get(second)).toBeNull();
      expect(calls.get("outside-a-run")).toMatchObject({ sourceRunId: null });
      calls.cancelBySourcePid({ uid: 1000, sourcePid: "proc:ship" });
      expect(calls.get("outside-a-run")).toBeNull();
      expect(calls.get(delegated)).toMatchObject({ responsibilityId: RESPONSIBILITY });
    });
  });
});
