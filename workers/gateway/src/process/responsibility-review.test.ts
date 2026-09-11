import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

describe("responsibility review", () => {
  it("requires reviewing a due waiting check before yielding", async () => {
    const runId = "run-r12y-waiting-review";
    const stub = await initProcess("mech-r12y-waiting-review", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const responsibility: ResponsibilityRecord = {
        id: "r12y:00000000-0000-4000-8000-000000000022", ownerUid: 0,
        title: "Confirm the plan", source: { kind: "account", uid: 0, username: "root" },
        assignee: { kind: "ship" }, state: "waiting", priority: "normal", blocker: "Waiting for your answer",
        nextCheckAtMs: Date.now() - 1, revision: 1, createdAtMs: 100, updatedAtMs: 100,
      };
      process.runs.active = {
        runId,
        responsibilityBatches: [{ batchId: "batch:00000000-0000-4000-8000-000000000023", responsibilityIds: [responsibility.id] }],
      };
      process.kernel.kernelRpc = vi.fn(async () => ({ responsibilities: [responsibility], count: 1, revision: responsibility.revision }));
      process.streams.silence = vi.fn(async () => {});
      const skipped = await process.run.executeRunControlAction(runId, "skip-review", { ok: true, command: { action: "yield" } }, []);
      expect(skipped).toMatchObject({ ok: false, error: expect.stringContaining(responsibility.id) });
      expect(process.streams.silence).not.toHaveBeenCalled();
      responsibility.nextCheckAtMs = Date.now() + 60_000;
      responsibility.revision += 1;
      const deferred = await process.run.executeRunControlAction(runId, "deferred-review", { ok: true, command: { action: "yield" } }, []);
      expect(deferred).toMatchObject({ ok: true, action: "yield", finish: true });
      expect(process.streams.silence).toHaveBeenCalledOnce();
    });
  });

});
