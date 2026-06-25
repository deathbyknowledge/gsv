import { describe, expect, it } from "vitest";
import type { ChatHistory } from "./processes";
import {
  applyChatSignal,
  emptyChatRuntimeState,
  transcriptRowsFromHistory,
} from "./transcript";

function history(messages: ChatHistory["messages"]): ChatHistory {
  return {
    pid: "pid-1",
    conversationId: "default",
    messages,
    messageCount: messages.length,
    truncated: false,
    hasMoreBefore: false,
    hasMoreAfter: false,
    activeRunId: null,
    activeConversationId: null,
    runState: "idle",
    pendingHil: null,
    context: null,
  };
}

describe("chat transcript rows", () => {
  it("keeps assistant text and folds tool results into tool rows", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "assistant",
        runId: "run-1",
        content: {
          text: "I'll inspect it.",
          toolCalls: [
            {
              id: "call-1",
              name: "Read",
              arguments: { path: "/tmp/a.txt" },
            },
          ],
        },
        text: "I'll inspect it.",
        timestamp: 1,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 2,
        clientId: "2",
        role: "toolResult",
        runId: "run-1",
        content: {
          toolName: "Read",
          toolCallId: "call-1",
          output: "file contents",
          ok: true,
        },
        text: "file contents",
        timestamp: 2,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ role: "assistant", text: "I'll inspect it." });
    expect(rows[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      text: "file contents",
    });
  });

  it("applies live stream, tool, and HIL signals for the active process", () => {
    let state = emptyChatRuntimeState("pid-1", "default");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      event: { type: "text_delta", delta: "Hello" },
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.tool.started", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      callId: "call-1",
      name: "Shell",
      syscall: "shell.exec",
      args: { input: "ls" },
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.hil.requested", {
      pid: "pid-1",
      requestId: "hil-1",
      runId: "run-1",
      conversationId: "default",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      args: { input: "ls" },
      createdAt: 1,
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.runState).toBe("awaiting_hil");
    expect(state.pendingHil?.requestId).toBe("hil-1");
    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "Hello", streaming: true }),
      expect.objectContaining({ role: "tool", toolCallId: "call-1", status: "running" }),
    ]));
  });
});
