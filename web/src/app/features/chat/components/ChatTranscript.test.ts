import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../domain/transcript";
import {
  collectGroupEntries,
  collectRunEntries,
  findMessageById,
  type ChatDockMessage,
} from "./ChatTranscript";

function msg(
  input: Partial<ChatTranscriptRow> & Pick<ChatTranscriptRow, "id">,
): ChatDockMessage {
  return {
    text: "",
    time: "",
    timestamp: 0,
    ...input,
  };
}

/** A tool result belongs to a run's activity group regardless of its text. */
function tool(id: string, runId: string | undefined): ChatDockMessage {
  return msg({ id, role: "toolResult", runId, text: "done", toolCallId: id, toolName: "Shell" });
}

/** A reasoning-only assistant message (no text, has thinking) is an activity entry. */
function reasoning(id: string, runId: string | undefined): ChatDockMessage {
  return msg({ id, role: "assistant", runId, thinking: ["pondering"] });
}

describe("collectRunEntries", () => {
  it("returns only activity entries whose runId matches", () => {
    const messages = [
      tool("t1", "run-1"),
      reasoning("r1", "run-1"),
      tool("t2", "run-2"),
    ];

    const entries = collectRunEntries(messages, "run-1");

    expect(entries.map((entry) => entry.message.id)).toEqual(["t1", "r1"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "reasoning"]);
  });

  it("skips non-activity messages such as user and assistant text rows", () => {
    const messages = [
      msg({ id: "u1", role: "user", text: "inspect it", runId: "run-1" }),
      msg({ id: "a1", role: "assistant", text: "on it", runId: "run-1" }),
      tool("t1", "run-1"),
    ];

    const entries = collectRunEntries(messages, "run-1");

    expect(entries.map((entry) => entry.message.id)).toEqual(["t1"]);
  });

  it("excludes activity entries carrying a null run id", () => {
    const messages = [tool("t1", undefined), tool("t2", "run-1")];

    const entries = collectRunEntries(messages, "run-1");

    expect(entries.map((entry) => entry.message.id)).toEqual(["t2"]);
  });

  it("returns an empty list when no entry matches the run", () => {
    expect(collectRunEntries([tool("t1", "run-1")], "run-9")).toEqual([]);
  });
});

describe("collectGroupEntries", () => {
  it("returns the contiguous same-run group containing the target message", () => {
    const messages = [tool("t1", "run-1"), reasoning("r1", "run-1"), tool("t2", "run-2")];

    const entries = collectGroupEntries(messages, "r1");

    expect(entries.map((entry) => entry.message.id)).toEqual(["t1", "r1"]);
  });

  it("returns only the containing segment when the same run id is split by another run", () => {
    // run-1 appears in two separate contiguous segments, split by a run-2 entry.
    const messages = [
      tool("a1", "run-1"),
      tool("a2", "run-1"),
      tool("b1", "run-2"),
      tool("c1", "run-1"),
    ];

    // The trailing run-1 message forms its own group, not merged with the leading one.
    expect(collectGroupEntries(messages, "c1").map((entry) => entry.message.id)).toEqual(["c1"]);
    // The leading run-1 segment stays intact for its own members.
    expect(collectGroupEntries(messages, "a2").map((entry) => entry.message.id)).toEqual(["a1", "a2"]);
  });

  it("returns an empty list when the message is not in any activity group", () => {
    const messages = [msg({ id: "u1", role: "user", text: "hi" }), tool("t1", "run-1")];

    expect(collectGroupEntries(messages, "u1")).toEqual([]);
    expect(collectGroupEntries(messages, "missing")).toEqual([]);
  });
});

describe("findMessageById", () => {
  it("returns the matching message", () => {
    const target = tool("t1", "run-1");

    expect(findMessageById([tool("t0", "run-1"), target], "t1")).toBe(target);
  });

  it("returns null on a miss", () => {
    expect(findMessageById([tool("t1", "run-1")], "nope")).toBeNull();
  });
});
