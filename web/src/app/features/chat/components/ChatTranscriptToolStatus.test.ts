import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../domain/transcript";
import {
  chatTranscriptActiveGroupIndex,
  chatTranscriptActivityGroupTone,
  chatTranscriptToolGroupTone,
  chatTranscriptToolStatusLabel,
  chatTranscriptToolTone,
} from "./ChatTranscriptToolStatus";

function tool(input: Partial<ChatTranscriptRow> = {}): ChatTranscriptRow {
  return {
    id: "tool-1",
    role: "toolResult",
    text: "",
    time: "",
    timestamp: null,
    ...input,
  };
}

describe("chat transcript tool status", () => {
  it.each([
    ["cancelled", "CANCELLED"],
    ["denied", "DENIED"],
  ] as const)("renders an expected %s outcome as a warning", (toolOutcome, label) => {
    const message = tool({ isError: true, status: "error", toolOutcome });

    expect(chatTranscriptToolTone(message)).toBe("warning");
    expect(chatTranscriptToolStatusLabel(message)).toBe(label);
  });

  it("keeps explicit and legacy failures red", () => {
    expect(chatTranscriptToolTone(tool({ toolOutcome: "failed" }))).toBe("error");
    expect(chatTranscriptToolTone(tool({ isError: true }))).toBe("error");
  });

  it("keeps a group red when it contains a genuine failure", () => {
    expect(chatTranscriptToolGroupTone([
      tool({ toolOutcome: "denied" }),
      tool({ toolOutcome: "failed" }),
    ])).toBe("error");
  });

  it("uses a warning group tone when all terminal errors are expected", () => {
    expect(chatTranscriptToolGroupTone([
      tool({ toolOutcome: "completed" }),
      tool({ isError: true, toolOutcome: "cancelled" }),
    ])).toBe("warning");
  });

  it("keeps a group running while reasoning continues after a completed tool", () => {
    expect(chatTranscriptActivityGroupTone([
      { kind: "tool", message: tool({ runId: "run-1", status: "done" }) },
      {
        kind: "reasoning",
        message: tool({
          id: "assistant-1",
          role: "assistant",
          runId: "run-1",
          status: "streaming",
          streaming: true,
        }),
      },
    ])).toBe("running");
  });

  it("keeps an active run group running when refreshed rows look terminal", () => {
    const entries = [
      { kind: "tool" as const, message: tool({ runId: "run-1", status: "done" }) },
      {
        kind: "reasoning" as const,
        message: tool({ id: "assistant-1", role: "assistant", runId: "run-1", status: "done" }),
      },
    ];

    expect(chatTranscriptActivityGroupTone(entries, true)).toBe("running");
    expect(chatTranscriptActivityGroupTone(entries)).toBe("done");
  });

  it("applies the active run override only to its final activity group", () => {
    const completed = [
      { kind: "tool" as const, message: tool({ runId: "run-1", status: "done" }) },
    ];
    const current = [
      {
        kind: "reasoning" as const,
        message: tool({ id: "assistant-1", role: "assistant", runId: "run-1", status: "done" }),
      },
    ];

    expect(chatTranscriptActiveGroupIndex([completed, current], "run-1")).toBe(1);
    expect(chatTranscriptActiveGroupIndex([completed, current], "run-2")).toBe(-1);
  });
});
