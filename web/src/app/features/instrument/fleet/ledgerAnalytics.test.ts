import { describe, expect, it } from "vitest";
import type { ProcHistoryRecord, ProcTraceSpan } from "@humansandmachines/gsv/protocol";
import { generationUsage, groupFailures, groupUsage, reportedCost, timelineBounds, timelinePosition, timelineRuns, type AnalysisLine } from "./ledgerAnalytics";

const window = { since: 100, until: 1_000 };
function record(overrides: Partial<Extract<ProcHistoryRecord, { kind: "note" }>> = {}): ProcHistoryRecord {
  return {
    id: 1, messageId: 2, index: 0, generation: 0, runId: "run:1", createdAt: 200, source: "typed",
    kind: "note", payload: { text: "", thinking: [] },
    metadata: {
      provider: { provider: "fixture", model: "requested", responseModel: "actual" },
      fallback: { used: true, from: { model: "original" }, to: { model: "actual" } },
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cost: null },
    },
    ...overrides,
  };
}

describe("ledger generation usage", () => {
  it("counts shared message metadata once and uses the responding model", () => {
    const generations = generationUsage("proc:a", [record(), record({ id: 2, index: 1 }), record({ id: 3, index: 2 })], window);
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ model: "actual", tokens: 100, cost: null, fallback: true });
    expect(groupUsage(generations, "model")[0]).toMatchObject({ id: "fixture · actual", tokens: 100, missingCost: 1, costReports: 0 });
  });

  it("keeps separate process/epoch identities and excludes generations outside the window", () => {
    const generations = [
      ...generationUsage("proc:a", [record(), record({ generation: 1 }), record({ createdAt: 99, messageId: 3 }), record({ createdAt: 1_001, messageId: 4 })], window),
      ...generationUsage("proc:b", [record()], window),
    ];
    expect(generations).toHaveLength(3);
    expect(groupUsage(generations, "process").map((group) => [group.id, group.tokens])).toEqual([["proc:a", 200], ["proc:b", 100]]);
  });

  it("keeps unknown, reported zero, and incomplete cost distinct", () => {
    const source = generationUsage("proc:a", [record()], window)[0];
    const group = groupUsage([source, { ...source, id: "zero", cost: 0 }, { ...source, id: "partial", cost: 0.002, costIncomplete: true }], "process")[0];
    expect(group).toMatchObject({ cost: 0.002, costReports: 2, missingCost: 2 });
    expect(reportedCost(0, false)).toBe("—");
    expect(reportedCost(0, true)).toBe("$0.00");
    expect(reportedCost(0.002, true)).toBe("$0.0020");
  });

  it("uses local calendar days across midnight", () => {
    const source = generationUsage("proc:a", [record()], window)[0];
    const groups = groupUsage([
      { ...source, timestamp: new Date(2026, 8, 8, 23, 59).getTime() },
      { ...source, id: "next", timestamp: new Date(2026, 8, 9, 0, 1).getTime() },
    ], "day");
    expect(groups.map((group) => group.id)).toEqual(["2026-09-08", "2026-09-09"]);
  });
});

function span(overrides: Partial<ProcTraceSpan> = {}): ProcTraceSpan {
  return { id: "root", runId: "run:1", kind: "run", name: "Run", status: "ok", startedAt: 50, endedAt: 500, ...overrides };
}

describe("ledger timelines", () => {
  it("uses root wall time without double counting nested spans and clips crossing runs", () => {
    const runs = timelineRuns([{ pid: "proc:a", truncated: false, spans: [span(), span({ id: "child", parentId: "root", kind: "tool", startedAt: 100, endedAt: 400 })] }], window);
    expect(runs[0].end - runs[0].start).toBe(450);
    expect(timelinePosition(runs[0].start, runs[0].end, window)).toEqual({ left: 0, width: 400 / 900 * 100 });
    expect(timelineBounds(runs, window, true)).toEqual({ since: 100, until: 500 });
  });

  it("keeps a running root open even when its children have finished", () => {
    const runs = timelineRuns([{ pid: "proc:a", truncated: false, spans: [span({ status: "running", endedAt: undefined }), span({ id: "child", kind: "tool", endedAt: 300 })] }], window);
    expect(runs[0]).toMatchObject({ end: 1_000, status: "running" });
  });

  it("marks missing roots as partial, preserves errors and isolates identical run ids by process", () => {
    const runs = timelineRuns([
      { pid: "proc:a", truncated: true, spans: [span({ kind: "inference", status: "error" })] },
      { pid: "proc:b", truncated: false, spans: [span()] },
    ], window);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.pid === "proc:a")).toMatchObject({ partial: true, status: "error" });
  });

  it("omits disjoint runs and keeps zero-duration charts finite", () => {
    expect(timelineRuns([{ pid: "proc:a", truncated: false, spans: [span({ startedAt: 0, endedAt: 99 })] }], window)).toEqual([]);
    expect(timelinePosition(10, 10, { since: 10, until: 10 })).toEqual({ left: 0, width: 0 });
  });
});

function line(overrides: Partial<AnalysisLine> = {}): AnalysisLine {
  return { id: "sys:1", timestamp: 100, processId: "proc:a", place: "gsv", syscall: "fs.read", what: "read a file", detail: "/missing", args: "{}", outcome: "failed", runId: "run:1", costNanoUsd: null, durationMs: 3, ...overrides };
}

describe("ledger failure groups", () => {
  it("groups only unsuccessful outcomes by operation and target, deduplicating overlapping pages", () => {
    const groups = groupFailures([
      line(), line(), line({ id: "sys:2", timestamp: 200 }),
      line({ id: "sys:3", outcome: "denied" }), line({ id: "sys:4", place: "laptop" }),
      line({ id: "sys:5", outcome: "completed" }), line({ id: "sys:6", outcome: "running" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].lines.map((entry) => entry.id)).toEqual(["sys:2", "sys:1"]);
    expect(groups.reduce((sum, group) => sum + group.lines.length, 0)).toBe(4);
  });
});
