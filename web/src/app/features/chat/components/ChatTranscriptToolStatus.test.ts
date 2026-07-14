import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../domain/transcript";
import {
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
});
