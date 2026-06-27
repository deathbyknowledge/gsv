import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../domain/transcript";
import { mergeTranscriptRows } from "./useChatRuntime";

function row(input: Partial<ChatTranscriptRow> & Pick<ChatTranscriptRow, "id" | "role" | "text" | "timestamp">): ChatTranscriptRow {
  return {
    time: "",
    ...input,
  };
}

describe("chat runtime row merging", () => {
  it("keeps live reasoning rows before later persisted tool results", () => {
    const startedAt = 1_782_600_000_000;
    const currentRows = [
      row({
        id: "message:1",
        role: "user",
        text: "inspect it",
        messageId: 1,
        timestamp: startedAt,
      }),
      row({
        id: "assistant:run-1",
        role: "assistant",
        text: "",
        thinking: ["I should inspect the file."],
        runId: "run-1",
        status: "streaming",
        streaming: true,
        timestamp: startedAt + 100,
      }),
    ];
    const nextRows = [
      row({
        id: "message:1",
        role: "user",
        text: "inspect it",
        messageId: 1,
        timestamp: startedAt,
      }),
      row({
        id: "tool:call-1",
        role: "toolResult",
        text: "done",
        messageId: 2,
        runId: "run-1",
        status: "done",
        timestamp: startedAt + 200,
        toolCallId: "call-1",
        toolName: "Shell",
      }),
    ];

    expect(mergeTranscriptRows(currentRows, nextRows).map((item) => item.id)).toEqual([
      "message:1",
      "assistant:run-1",
      "tool:call-1",
    ]);
  });
});
