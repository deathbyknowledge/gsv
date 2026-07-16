import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../domain/transcript";
import {
  buildTranscriptRenderItems,
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

describe("buildTranscriptRenderItems — streaming reasoning tail", () => {
  /** An assistant row mid-answer: streaming, has text AND reasoning. */
  function streamingAnswer(runId: string | undefined): ChatDockMessage {
    return msg({ id: "a1", role: "assistant", runId, text: "Here is what I found", thinking: ["pondering"], streaming: true });
  }

  it("appends a synthetic reasoning group while a tool-less answer streams", () => {
    const items = buildTranscriptRenderItems([
      msg({ id: "u1", role: "user", text: "go" }),
      streamingAnswer("run-1"),
    ]);

    const tail = items[items.length - 1];
    expect(tail.kind).toBe("activityGroup");
    expect(tail.id).toBe("activity-tail:run-1");
    if (tail.kind === "activityGroup") {
      expect(tail.entries.map((entry) => entry.kind)).toEqual(["reasoning"]);
      expect(tail.entries[0].message.id).toBe("a1");
    }
    // The streaming text itself still renders as a normal message row.
    expect(items.filter((item) => item.kind === "message").map((item) => item.kind === "message" && item.message.id)).toContain("a1");
  });

  it("drops the tail once the answer finishes streaming", () => {
    const items = buildTranscriptRenderItems([
      msg({ id: "a1", role: "assistant", runId: "run-1", text: "Done", thinking: ["pondering"], streaming: false }),
    ]);

    expect(items.every((item) => item.kind === "message")).toBe(true);
  });

  it("adds no tail when the streaming answer has no reasoning", () => {
    const items = buildTranscriptRenderItems([
      msg({ id: "a1", role: "assistant", runId: "run-1", text: "Streaming along", streaming: true }),
    ]);

    expect(items.every((item) => item.kind === "message")).toBe(true);
  });

  it("does not duplicate the group for a reasoning-only streaming row", () => {
    // No text yet → the row is already a reasoning activity entry by itself.
    const items = buildTranscriptRenderItems([
      msg({ id: "a1", role: "assistant", runId: "run-1", thinking: ["pondering"], streaming: true }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("activityGroup");
    expect(items[0].id.startsWith("activity-tail:")).toBe(false);
  });

  it("adds no tail when the run already has a real activity group", () => {
    // The tool group carries the EXPAND REASONING affordance already.
    const items = buildTranscriptRenderItems([
      tool("t1", "run-1"),
      streamingAnswer("run-1"),
    ]);

    const groups = items.filter((item) => item.kind === "activityGroup");
    expect(groups).toHaveLength(1);
    expect(groups[0].id.startsWith("activity-tail:")).toBe(false);
  });

  it("keys the tail by message id when the row has no run id", () => {
    const items = buildTranscriptRenderItems([streamingAnswer(undefined)]);

    const tail = items[items.length - 1];
    expect(tail.id).toBe("activity-tail:a1");
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
