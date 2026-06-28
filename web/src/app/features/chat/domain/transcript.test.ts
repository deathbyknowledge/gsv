import { describe, expect, it } from "vitest";
import type { ChatHistory } from "./processes";
import {
  addOptimisticUserMessage,
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
      messageId: 2,
      toolCallId: "call-1",
      toolName: "Read",
      text: "file contents",
    });
  });

  it("keeps historical tool activity before later conversation messages", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "user",
        runId: "run-tools",
        content: "try your tools",
        text: "try your tools",
        timestamp: 1,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 2,
        clientId: "2",
        role: "assistant",
        runId: "run-tools",
        content: {
          text: "\n",
          thinking: [{ type: "thinking", thinking: "I'll run a command." }],
          toolCalls: [
            {
              id: "call-1",
              name: "Shell",
              arguments: { input: "pwd" },
            },
          ],
        },
        text: "\n",
        timestamp: 2,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 3,
        clientId: "3",
        role: "toolResult",
        runId: "run-tools",
        content: {
          toolName: "Shell",
          toolCallId: "call-1",
          output: "done",
          ok: true,
        },
        text: "done",
        timestamp: 3,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 4,
        clientId: "4",
        role: "assistant",
        runId: "run-tools",
        content: {
          text: "Finished.",
          thinking: [],
          toolCalls: [],
        },
        text: "Finished.",
        timestamp: 4,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 5,
        clientId: "5",
        role: "user",
        runId: "run-later",
        content: "later",
        text: "later",
        timestamp: 5,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows.map((row) => row.messageId)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
  });

  it("does not add an empty activity row for a run starting", () => {
    let state = addOptimisticUserMessage(
      emptyChatRuntimeState("pid-1", "default"),
      "hello",
      "default",
    );

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      event: {
        type: "start",
        partial: {
          content: [],
        },
      },
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.rows).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hello",
      }),
    ]);
    expect(state.runState).toBe("running");
    expect(state.activeRunId).toBe("run-1");
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

  it("uses stream partial snapshots as authoritative assistant text", () => {
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
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "world",
        partial: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "!",
        partial: {
          content: [{ type: "text", text: "Hello world!" }],
        },
      },
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        runId: "run-1",
        text: "Hello world!",
        streaming: true,
      }),
    ]));
  });

  it("drops stream fallback tool rows when concrete tool events arrive", () => {
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
      event: {
        type: "toolcall_start",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          name: "Shell",
          arguments: { input: "pwd" },
        },
      },
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        status: "planning",
        toolCallId: "run-1:tool:0",
      }),
    ]));

    state = applyChatSignal(state, "proc.run.tool.started", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      callId: "call-1",
      name: "Shell",
      syscall: "shell.exec",
      args: { input: "pwd" },
    }, { pid: "pid-1", conversationId: "default" }).state;

    state = applyChatSignal(state, "proc.run.tool.finished", {
      pid: "pid-1",
      runId: "run-1",
      conversationId: "default",
      callId: "call-1",
      name: "Shell",
      syscall: "shell.exec",
      ok: true,
      output: "done",
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.rows.filter((row) => row.toolCallId === "run-1:tool:0")).toHaveLength(0);
    expect(state.rows.filter((row) => row.role === "tool" || row.role === "toolResult")).toEqual([
      expect.objectContaining({
        role: "toolResult",
        status: "done",
        toolCallId: "call-1",
      }),
    ]);
  });

  it("replaces one optimistic user row when the persisted message signal arrives", () => {
    let state = addOptimisticUserMessage(
      emptyChatRuntimeState("pid-1", "default"),
      "hello",
      "default",
    );
    state = addOptimisticUserMessage(state, "hello", "default");

    state = applyChatSignal(state, "proc.changed", {
      pid: "pid-1",
      conversationId: "default",
      changes: ["messages"],
      role: "user",
      content: "hello",
      messageId: 42,
      timestamp: Date.now(),
    }, { pid: "pid-1", conversationId: "default" }).state;

    expect(state.rows.filter((row) => row.role === "user" && row.text === "hello")).toHaveLength(2);
    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "message:42", role: "user", text: "hello" }),
    ]));
    expect(state.rows.filter((row) => row.id.startsWith("optimistic:user:"))).toHaveLength(1);
  });
});
