import { describe, expect, it } from "vitest";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";

function seedRun(process: Process, runId: string, startedAt: number, origin: string): void {
  const { store } = process;
  store.messages.appendMessage("user", "SECRET-INPUT the person's private words", {
    runId, origin: JSON.stringify({ kind: origin }), createdAt: startedAt,
  });
  store.messages.appendRunRecord(runId, {
    kind: "call",
    payload: { callId: `${runId}:call`, tool: "Shell", syscall: "shell.exec", args: { input: "SECRET-ARGS" }, target: "macbook-air", runId },
  });
  store.messages.appendRunRecord(runId, {
    kind: "result",
    payload: { callId: `${runId}:call`, tool: "Shell", outcome: "completed", output: "SECRET-OUTPUT", media: [], resources: [] },
  });
  const spans = store.traces;
  spans.startTraceSpan({ id: `run:${runId}`, runId, kind: "run", name: "Run", startedAt });
  spans.startTraceSpan({ id: `${runId}:inference`, runId, parentId: `run:${runId}`, kind: "inference", name: "gsv · default", startedAt: startedAt + 1_000 });
  spans.finishTraceSpan(`${runId}:inference`, "ok", startedAt + 3_000);
  spans.startTraceSpan({
    id: `${runId}:shell`, runId, parentId: `run:${runId}`, kind: "tool", name: "Shell", startedAt: startedAt + 3_000,
    reference: { kind: "tool", callId: `${runId}:call`, executionId: "execution" },
  });
  spans.startTraceSpan({ id: `${runId}:execute`, runId, parentId: `${runId}:shell`, kind: "tool", name: "Execute", startedAt: startedAt + 3_100 });
  spans.finishTraceSpan(`${runId}:execute`, "ok", startedAt + 378_000);
  spans.finishTraceSpan(`${runId}:shell`, "ok", startedAt + 378_000);
  spans.startTraceSpan({ id: `${runId}:delivery`, runId, parentId: `run:${runId}`, kind: "delivery", name: "Send message", startedAt: startedAt + 379_000 });
  spans.finishTraceSpan(`${runId}:delivery`, "ok", startedAt + 379_200);
}

describe("operator run summary", () => {
  it("still describes a run whose legacy message has a malformed origin", async () => {
    const stub = await initProcess("operator-summary-legacy-origin", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      seedRun(process, "run:msg:legacy", 1_000_000, "client");
      process.store.sql.exec("UPDATE messages SET origin_json = '{not json' WHERE run_id = 'run:msg:legacy' AND role = 'user'");
      process.store.traces.finishRunTrace("run:msg:legacy", "ok", 1_010_000);

      const summary = await process.operatorRunSummary(10);

      expect(summary?.runs.map((run) => [run.runId, run.origin, run.inputChars])).toEqual([
        ["run:msg:legacy", "other", "SECRET-INPUT the person's private words".length],
      ]);
    });
  });

  it("describes recent runs with timings and outcomes, newest first, without any content", async () => {
    const stub = await initProcess("operator-summary", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      seedRun(process, "adapter-run:first", 1_000_000, "adapter");
      process.store.traces.finishRunTrace("adapter-run:first", "ok", 1_438_800);
      seedRun(process, "run:msg:second", 2_000_000, "client");
      process.store.traces.finishRunTrace("run:msg:second", "aborted", 2_010_000);
      process.store.history.recordHistorySegment({
        id: "segment", generation: 1, kind: "compaction", fromMessageId: 1, toMessageId: 2, archivePath: "archive",
      });

      const summary = await process.operatorRunSummary(10);

      expect(summary).toMatchObject({ pendingApprovals: 0, lastCompactionAt: expect.any(Number) });
      expect(summary?.runs.map((run) => [run.runId, run.origin, run.status])).toEqual([
        ["run:msg:second", "client", "aborted"],
        ["adapter-run:first", "adapter", "ok"],
      ]);
      expect(summary?.runs[1]).toMatchObject({
        inputChars: "SECRET-INPUT the person's private words".length,
        inputHasMedia: false,
        startedAt: 1_000_000,
        durationMs: 438_800,
        steps: [
          { kind: "inference", name: "gsv · default", durationMs: 2_000, status: "ok" },
          { kind: "tool", name: "Shell", target: "macbook-air", durationMs: 375_000, status: "ok" },
          { kind: "delivery", name: "Send message", durationMs: 200, status: "ok" },
        ],
      });
      expect(JSON.stringify(summary)).not.toContain("SECRET");
    });
  });

  it("returns only the requested number of runs", async () => {
    const stub = await initProcess("operator-summary-limit", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      for (const index of [1, 2, 3]) {
        seedRun(process, `adapter-run:${index}`, index * 1_000_000, "adapter");
        process.store.traces.finishRunTrace(`adapter-run:${index}`, "ok", index * 1_000_000 + 500_000);
      }
      expect((await process.operatorRunSummary(2))?.runs.map((run) => run.runId)).toEqual(["adapter-run:3", "adapter-run:2"]);
      await expect(process.operatorRunSummary(51)).rejects.toThrow("runLimit");
    });
  });
});
