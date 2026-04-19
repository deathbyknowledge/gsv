import { describe, expect, it } from "vitest";
import {
  buildCheckpointTranscript,
  normalizeCheckpointCommitMessage,
  normalizeCheckpointSummary,
} from "./checkpoint";
import type { MessageRecord } from "./store";

describe("buildCheckpointTranscript", () => {
  it("serializes transcript records as jsonl", () => {
    const messages: MessageRecord[] = [
      {
        id: 1,
        role: "user",
        content: "hello",
        toolCalls: null,
        toolCallId: null,
        createdAt: 1_700_000_000_000,
      },
      {
        id: 2,
        role: "assistant",
        content: "reading file",
        toolCalls: JSON.stringify({
          thinking: [{ type: "thinking", thinking: "Need to inspect the file first." }],
          toolCalls: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
        }),
        toolCallId: null,
        createdAt: 1_700_000_000_100,
      },
    ];

    const lines = buildCheckpointTranscript(messages).split("\n").map((line) => JSON.parse(line));

    expect(lines).toEqual([
      {
        role: "user",
        content: "hello",
        ts: 1_700_000_000_000,
      },
      {
        role: "assistant",
        content: "reading file",
        thinking: [{ type: "thinking", thinking: "Need to inspect the file first." }],
        tool_calls: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
        ts: 1_700_000_000_100,
      },
    ]);
  });
});

describe("normalizeCheckpointSummary", () => {
  it("trims summary text and keeps a trailing newline", () => {
    expect(normalizeCheckpointSummary("  hello\nworld  ")).toBe("hello\nworld\n");
  });
});

describe("normalizeCheckpointCommitMessage", () => {
  it("normalizes quotes, case, and trailing punctuation", () => {
    expect(normalizeCheckpointCommitMessage(' "Add Shell Support." ')).toBe("add shell support");
  });

  it("falls back when the model returns blank output", () => {
    expect(normalizeCheckpointCommitMessage("   ")).toBe("checkpoint thread state");
  });
});
