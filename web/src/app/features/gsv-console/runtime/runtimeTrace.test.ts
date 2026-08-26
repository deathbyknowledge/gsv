import type { ProcTraceSpan } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../../chat/domain/transcript";
import {
  buildRuntimeFlameChart,
  runtimeTraceInspectorSections,
} from "./runtimeTrace";

describe("runtime trace", () => {
  it("lays out wall-clock spans and resolves their stored values", () => {
    const spans: ProcTraceSpan[] = [
      span("run:1", "run", 0, 1_000, { reference: { kind: "run" } }),
      span("context:1", "context", 0, 100, { parentId: "run:1" }),
      span("inference:1", "inference", 100, 500, {
        parentId: "run:1",
        reference: { kind: "message", messageId: 2 },
      }),
      span("reasoning:1", "reasoning", 150, 300, { parentId: "inference:1" }),
      span("output:1", "output", 300, 500, { parentId: "inference:1" }),
      span("tool:1", "tool", 500, 900, {
        parentId: "run:1",
        reference: { kind: "tool", callId: "call-1", executionId: "dispatch-1" },
      }),
      span("execution:1", "tool", 600, 800, { parentId: "tool:1" }),
    ];
    const rows: ChatTranscriptRow[] = [
      row("user:1", "user", "Inspect the repository", { messageId: 1 }),
      row("message:2", "assistant", "I found it.", {
        messageId: 2,
        thinking: ["I should inspect the manifest."],
      }),
      row("tool:call-1", "tool", "git status --short", {
        messageId: 2,
        toolCallId: "call-1",
        toolName: "Shell",
        toolArgs: { input: "git status --short" },
      }),
      row("tool-result:call-1", "toolResult", " M package.json", {
        messageId: 3,
        toolCallId: "call-1",
        toolName: "Shell",
        toolOutput: " M package.json",
      }),
    ];

    const chart = buildRuntimeFlameChart(spans, "run-1", 1_000);
    expect(chart).not.toBeNull();
    expect(chart?.durationMs).toBe(1_000);
    expect(chart?.spans.find((candidate) => candidate.id === "inference:1"))
      .toMatchObject({ leftPercent: 10, widthPercent: 40, lane: 1 });
    expect(chart?.spans.find((candidate) => candidate.id === "reasoning:1")?.lane)
      .toBeGreaterThan(1);

    expect(runtimeTraceInspectorSections(spans[3], spans, rows)).toEqual([
      { label: "REASONING", value: "I should inspect the manifest." },
    ]);
    expect(runtimeTraceInspectorSections(spans[6], spans, rows)).toEqual([
      { label: "TOOL", value: "Shell" },
      { label: "ARGUMENTS", value: "{\n  \"input\": \"git status --short\"\n}" },
      { label: "RESULT", value: " M package.json" },
    ]);
  });
});

function span(
  id: string,
  kind: ProcTraceSpan["kind"],
  startedAt: number,
  endedAt: number,
  extra: Partial<ProcTraceSpan> = {},
): ProcTraceSpan {
  return {
    id,
    runId: "run-1",
    kind,
    name: id,
    status: "ok",
    startedAt,
    endedAt,
    ...extra,
  };
}

function row(
  id: string,
  role: ChatTranscriptRow["role"],
  text: string,
  extra: Partial<ChatTranscriptRow> = {},
): ChatTranscriptRow {
  return {
    id,
    runId: "run-1",
    role,
    text,
    time: "",
    timestamp: 1,
    ...extra,
  };
}
