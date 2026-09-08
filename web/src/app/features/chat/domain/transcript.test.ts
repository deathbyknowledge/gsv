import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatHistory } from "./processes";
import { jsonValueSchema, jsonObjectSchema, procHistoryRecordDataSchema, procHistoryRecordSchema, type InteractionOrigin, type ProcMessageMetadata, type JsonObject } from "@humansandmachines/gsv/protocol";
import { preserveDirectedConversationDelivery } from "./conversations";
import {
  addOptimisticUserMessage,
  applyChatSignal,
  emptyChatRuntimeState,
  newerContextSnapshot,
  transcriptRowsFromHistory,
} from "./transcript";

type HistoryFixture = {
  id: number | null;
  clientId: string;
  runId: string | null;
  role: "assistant" | "system" | "toolResult" | "user";
  content: unknown;
  text: string;
  timestamp: number | null;
  origin?: InteractionOrigin;
  metadata?: ProcMessageMetadata;
};

function history(messages: HistoryFixture[]): ChatHistory {
  const records = messages.flatMap((message, ordinal) => {
    const value = jsonValueSchema.parse(message.content);
    const parsedContent = jsonObjectSchema.safeParse(value);
    const content: JsonObject = parsedContent.success ? parsedContent.data : {};
    let members: unknown[];
    if (message.role === "assistant") {
      const thinking = Array.isArray(content.thinking) ? content.thinking.map((block) => z.string().safeParse(block).success ? { type: "thinking", thinking: block } : block) : [];
      const calls = Array.isArray(content.toolCalls) ? content.toolCalls : [];
      members = [
        { kind: "note", payload: { text: z.string().safeParse(content.text).success ? content.text : message.text, thinking, media: content.media ?? [] } },
        ...calls.map((item) => {
          const call = jsonObjectSchema.parse(item);
          return { kind: "call", payload: { callId: call.id, tool: call.name, syscall: call.syscall ?? null, args: call.arguments ?? {}, target: null, runId: message.runId } };
        }),
      ];
    } else if (message.role === "toolResult") {
      members = [{ kind: "result", payload: {
        callId: content.toolCallId, tool: content.toolName, outcome: content.outcome ?? (content.isError ? "failed" : "completed"),
        output: content.output ?? message.text, media: content.media ?? [], resources: content.resources ?? [],
      } }];
    } else if (message.role === "system") {
      members = [{ kind: "event", payload: { kind: "legacy", payload: { text: message.text }, severity: "info", audience: "model" } }];
    } else {
      members = [{ kind: "message", payload: { direction: "in", text: message.text, media: content.media ?? [], origin: { interaction: message.origin } } }];
    }
    return members.map((member, index) => procHistoryRecordSchema.parse({
      ...procHistoryRecordDataSchema.parse(member), id: ordinal + index + 1, messageId: message.id ?? ordinal + 1, index,
      runId: message.runId, generation: 1, createdAt: message.timestamp ?? 1, source: "typed", metadata: message.metadata,
    }));
  });
  return {
    pid: "pid-1", records, messageCount: messages.length, cursor: "fixture:1",
    historyRevision: 1, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false,
    truncated: false, hasMoreBefore: false, hasMoreAfter: false,
    activeRunId: null, runState: "idle", pendingHil: null, context: null, contextRevision: 0,
  };
}

describe("chat transcript rows", () => {
  it("does not downgrade a live directed Message during history synchronization", () => {
    const current = {
      id: "conversation:msg-one",
      role: "assistant" as const,
      text: "hello",
      time: "",
      timestamp: 1,
      delivery: "directed" as const,
    };
    const synchronized = { ...current, delivery: "sync" as const };

    expect(preserveDirectedConversationDelivery(current, synchronized).delivery)
      .toBe("directed");
    expect(preserveDirectedConversationDelivery(undefined, synchronized).delivery)
      .toBe("sync");
  });

  it("renders media attached to a historical assistant reply", () => {
    const media = {
      type: "document",
      mimeType: "application/pdf",
      filename: "report.pdf",
      key: "var/media/1000/proc-1/report",
      path: "/var/media/1000/proc-1/report",
      size: 3,
    };
    const rows = transcriptRowsFromHistory(history([{
      id: 1,
      clientId: "1",
      role: "assistant",
      runId: "run-1",
      content: { text: "Here is the report.", media: [media] },
      text: "Here is the report.",
      timestamp: 1,
      origin: undefined,
      metadata: undefined,
    }]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "Here is the report.",
        media: [media],
      }),
    ]);
  });

  it("shows canonical Message media from the live output signal", () => {
    const media = {
      type: "image",
      mimeType: "image/png",
      key: "var/media/1000/proc-1/image",
      path: "/var/media/1000/proc-1/image",
      size: 3,
    };
    const state = applyChatSignal(
      emptyChatRuntimeState("proc-1"),
      "proc.run.output",
      {
        pid: "proc-1",
        runId: "run-1",
        text: "Generated image.",
        media: [media],
      },
      { pid: "proc-1" },
    ).state;

    expect(state.rows).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "Generated image.",
        media: [media],
      }),
    ]);
  });

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

  it("does not render an empty assistant envelope as raw JSON", () => {
    const rows = transcriptRowsFromHistory(history([{
      id: 1,
      clientId: "1",
      role: "assistant",
      runId: "run-1",
      content: {
        text: "",
        thinking: [{ type: "thinking", thinking: "Inspect the contact message." }],
        toolCalls: [{
          id: "call-1",
          name: "Shell",
          arguments: { input: "message history --json" },
        }],
      },
      text: JSON.stringify({
        text: "",
        thinking: [{ type: "thinking", thinking: "Inspect the contact message." }],
      }),
      timestamp: 1,
      origin: undefined,
      metadata: undefined,
    }]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "",
        thinking: ["Inspect the contact message."],
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        toolName: "Shell",
      }),
    ]);
    expect(rows.some((row) => row.text.includes("\"thinking\""))).toBe(false);
  });

  it("keeps tool result media available to the transcript", () => {
    const media = [{
      type: "image",
      mimeType: "image/jpeg",
      key: "var/media/0/pid/tool-image",
      path: "/var/media/0/pid/tool-image",
    }];
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "toolResult",
        runId: "run-1",
        content: {
          toolName: "Read",
          toolCallId: "call-image",
          output: { path: "/var/media/0/pid/tool-image" },
          outcome: "completed",
          media,
        },
        text: "image result",
        timestamp: 1,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-image",
        media,
      }),
    ]);
  });

  it("keeps retained resource blocks available to the transcript", () => {
    const resources = [{
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path: "/root/.gsv/media/archived-media:one",
        revision: '"revision-one"',
        contentType: "image/png",
        size: 3,
      },
    }];
    const rows = transcriptRowsFromHistory(history([{
      id: 1,
      clientId: "1",
      role: "toolResult",
      runId: "run-1",
      content: {
        toolName: "Read",
        toolCallId: "call-resource",
        output: { kind: "image" },
        outcome: "completed",
        resources,
      },
      text: "image result",
      timestamp: 1,
      origin: undefined,
      metadata: undefined,
    }]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-resource",
        media: resources,
      }),
    ]);
  });

  it.each([
    ["completed", false],
    ["failed", true],
    ["cancelled", true],
    ["denied", true],
  ] as const)("normalizes the structured %s tool outcome", (outcome, isError) => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "toolResult",
        runId: "run-1",
        content: {
          toolName: "Shell",
          toolCallId: "call-1",
          output: "result",
          outcome,
          isError,
        },
        text: "result",
        timestamp: 1,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "toolResult",
        toolOutcome: outcome,
        isError,
      }),
    ]);
  });

  it("keeps failed outcomes from the typed history boundary", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "toolResult",
        runId: "run-1",
        content: {
          toolName: "Shell",
          toolCallId: "call-1",
          output: "Error: command failed",
          isError: true,
        },
        text: "Error: command failed",
        timestamp: 1,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "toolResult",
        isError: true,
      }),
    ]);
    expect(rows[0].toolOutcome).toBe("failed");
  });

  it("keeps backup model metadata on assistant history rows", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "assistant",
        runId: "run-1",
        content: { text: "Recovered answer.", toolCalls: [] },
        text: "Recovered answer.",
        timestamp: 1,
        origin: undefined,
        metadata: {
          fallback: {
            used: true,
            from: { provider: "custom", model: "zai-glm-4.7" },
            to: { provider: "openrouter", model: "openai/gpt-5-mini" },
            reason: "Custom provider HTTP 403: not authenticated",
          },
        },
      },
    ]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      text: "Recovered answer.",
      backupModel: {
        from: { provider: "custom", model: "zai-glm-4.7" },
        to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        reason: "Custom provider HTTP 403: not authenticated",
      },
    });
  });

  it("keeps backup model metadata visible for tool-only assistant history rows", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "assistant",
        runId: "run-1",
        content: {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              name: "Read",
              arguments: { path: "/tmp/a.txt" },
            },
          ],
        },
        text: "",
        timestamp: 1,
        origin: undefined,
        metadata: {
          fallback: {
            used: true,
            from: { provider: "custom", model: "zai-glm-4.7" },
            to: { provider: "openrouter", model: "openai/gpt-5-mini" },
          },
        },
      },
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        id: "message:1",
        role: "assistant",
        text: "",
        backupModel: {
          from: { provider: "custom", model: "zai-glm-4.7" },
          to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        },
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        toolName: "Read",
      }),
    ]);
  });

  it("keeps fallback tool ids scoped to their run when folding history", () => {
    const rows = transcriptRowsFromHistory(history([
      {
        id: 1,
        clientId: "1",
        role: "assistant",
        runId: "run-1",
        content: {
          text: "",
          toolCalls: [
            {
              id: "workers-ai-tool-1",
              name: "Read",
              arguments: { path: "/tmp/old.txt" },
            },
          ],
        },
        text: "",
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
          toolCallId: "workers-ai-tool-1",
          output: "old",
          ok: true,
        },
        text: "old",
        timestamp: 2,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 3,
        clientId: "3",
        role: "assistant",
        runId: "run-2",
        content: {
          text: "",
          toolCalls: [
            {
              id: "workers-ai-tool-1",
              name: "Read",
              arguments: { path: "/tmp/new.txt" },
            },
          ],
        },
        text: "",
        timestamp: 3,
        origin: undefined,
        metadata: undefined,
      },
      {
        id: 4,
        clientId: "4",
        role: "toolResult",
        runId: "run-2",
        content: {
          toolName: "Read",
          toolCallId: "workers-ai-tool-1",
          output: "new",
          ok: true,
        },
        text: "new",
        timestamp: 4,
        origin: undefined,
        metadata: undefined,
      },
    ]));

    expect(rows).toEqual([
      expect.objectContaining({
        role: "toolResult",
        runId: "run-1",
        toolArgs: { path: "/tmp/old.txt" },
        toolCallId: "workers-ai-tool-1",
        toolOutput: "old",
      }),
      expect.objectContaining({
        role: "toolResult",
        runId: "run-2",
        toolArgs: { path: "/tmp/new.txt" },
        toolCallId: "workers-ai-tool-1",
        toolOutput: "new",
      }),
    ]);
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
      emptyChatRuntimeState("pid-1"),
      "hello",
    );

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: {
        type: "start",
        partial: {
          content: [],
        },
      },
    }, { pid: "pid-1" }).state;

    expect(state.rows).toEqual([
      expect.objectContaining({
        role: "user",
        text: "hello",
      }),
    ]);
    expect(state.runState).toBe("running");
    expect(state.activeRunId).toBe("run-1");
  });

  it("does not let late signals replace the active run", () => {
    let state = applyChatSignal(
      emptyChatRuntimeState("pid-1"),
      "proc.run.started",
      { pid: "pid-1", runId: "run-new" },
      { pid: "pid-1" },
    ).state;

    state = applyChatSignal(state, "proc.run.finished", {
      pid: "pid-1",
      runId: "run-old",
      status: "aborted",
      queuedCount: 0,
    }, { pid: "pid-1" }).state;

    expect(state.activeRunId).toBe("run-new");
    expect(state.runState).toBe("running");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-old",
    }, { pid: "pid-1" }).state;

    expect(state.activeRunId).toBe("run-new");
  });

  it("hides flagged thinking in live output while preserving visible and legacy blocks", () => {
    const payload = {
      pid: "pid-1", runId: "run-1", text: "Visible answer", timestamp: 1,
      thinking: [
        "Legacy visible reasoning",
        { thinking: "Visible reasoning", redacted: false, thinkingSignature: "visible-signature" },
        { text: "Visible legacy alias" },
        { thinking: "opaque provider data", redacted: true, thinkingSignature: "hidden-signature" },
        { text: "opaque legacy alias", redacted: true },
      ],
    };
    const retained = structuredClone(payload);
    const { state, refreshHistory } = applyChatSignal(
      emptyChatRuntimeState("pid-1"), "proc.run.output", payload, { pid: "pid-1" },
    );

    expect(refreshHistory).toBe(true);
    expect(state.rows).toEqual([expect.objectContaining({
      role: "assistant", text: "Visible answer",
      thinking: ["Legacy visible reasoning", "Visible reasoning", "Visible legacy alias", "[redacted thinking]", "[redacted thinking]"],
      streaming: false, status: "done",
    })]);
    expect(payload).toEqual(retained);
  });

  it.each([
    { text: "", partialText: "" },
    { text: "Visible answer", partialText: "" },
    { text: "", partialText: "Ordinary partial text" },
  ])("masks partial thinking on completion '$text' after partial text '$partialText'", ({ text, partialText }) => {
    const previous = {
      id: "message:7", role: "assistant" as const, runId: "run-1", text: "Earlier committed note",
      thinking: ["Earlier visible reasoning"], timestamp: 1, time: "", status: "done" as const,
    };
    let thinking = applyChatSignal({ ...emptyChatRuntimeState("pid-1"), rows: [previous] }, "proc.run.stream", {
      pid: "pid-1", runId: "run-1", event: { type: "thinking_start" },
    }, { pid: "pid-1" }).state;
    thinking = applyChatSignal(thinking, "proc.run.stream", {
      pid: "pid-1", runId: "run-1", event: { type: "thinking_delta", delta: "Partial reasoning later redacted" },
    }, { pid: "pid-1" }).state;
    if (partialText) thinking = applyChatSignal(thinking, "proc.run.stream", {
      pid: "pid-1", runId: "run-1", event: { type: "text_delta", delta: partialText },
    }, { pid: "pid-1" }).state;
    const { state } = applyChatSignal(thinking, "proc.run.output", {
      pid: "pid-1", runId: "run-1", text,
      thinking: [{ thinking: "opaque provider data", redacted: true }],
    }, { pid: "pid-1" });

    expect(state.rows).toEqual([previous, expect.objectContaining({
      role: "assistant", text, thinking: ["[redacted thinking]"], streaming: false, status: "done",
    })]);
    expect(thinking.rows[1].thinking).toEqual(["Partial reasoning later redacted"]);
  });

  it("keeps streamed thinking when completion omits it without explicit redaction", () => {
    const thinking = applyChatSignal(emptyChatRuntimeState("pid-1"), "proc.run.stream", {
      pid: "pid-1", runId: "run-1", event: { type: "thinking_delta", delta: "Visible partial reasoning" },
    }, { pid: "pid-1" }).state;
    const { state } = applyChatSignal(thinking, "proc.run.output", {
      pid: "pid-1", runId: "run-1", text: "Visible answer", thinking: [],
    }, { pid: "pid-1" });
    expect(state.rows).toEqual([expect.objectContaining({
      text: "Visible answer", thinking: ["Visible partial reasoning"],
    })]);
  });

  it("moves live backup model status onto the assistant answer", () => {
    let state = emptyChatRuntimeState("pid-1");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.retrying", {
      pid: "pid-1",
      runId: "run-1",
      reason: "Custom provider HTTP 403: not authenticated",
      fallback: {
        from: { provider: "custom", model: "zai-glm-4.7" },
        to: { provider: "openrouter", model: "openai/gpt-5-mini" },
      },
    }, { pid: "pid-1" }).state;

    expect(state.rows).toEqual([
      expect.objectContaining({
        id: "backup:run-1",
        role: "assistant",
        text: "",
        streaming: true,
        backupModel: {
          from: { provider: "custom", model: "zai-glm-4.7" },
          to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        },
      }),
    ]);

    state = applyChatSignal(state, "proc.run.output", {
      pid: "pid-1",
      runId: "run-1",
      text: "Recovered answer.",
      fallback: {
        used: true,
        from: { provider: "custom", model: "zai-glm-4.7" },
        to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        reason: "Custom provider HTTP 403: not authenticated",
      },
    }, { pid: "pid-1" }).state;

    expect(state.rows).toEqual([
      expect.objectContaining({
        id: "assistant:run-1",
        role: "assistant",
        text: "Recovered answer.",
        streaming: false,
        backupModel: {
          from: { provider: "custom", model: "zai-glm-4.7" },
          to: { provider: "openrouter", model: "openai/gpt-5-mini" },
          reason: "Custom provider HTTP 403: not authenticated",
        },
      }),
    ]);
  });

  it("applies live stream, tool, and HIL signals for the active process", () => {
    let state = emptyChatRuntimeState("pid-1");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: { type: "text_delta", delta: "Hello" },
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.tool.started", {
      pid: "pid-1",
      runId: "run-1",
      callId: "call-1",
      name: "Shell",
      syscall: "shell.exec",
      args: { input: "ls" },
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.hil.requested", {
      pid: "pid-1",
      requestId: "hil-1",
      runId: "run-1",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "macbook",
      args: { input: "ls" },
      createdAt: 1,
    }, { pid: "pid-1" }).state;

    expect(state.runState).toBe("awaiting_hil");
    expect(state.pendingHil).toMatchObject({
      pid: "pid-1",
      requestId: "hil-1",
      target: "macbook",
    });
    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "Hello", streaming: true }),
      expect.objectContaining({ role: "tool", toolCallId: "call-1", status: "running" }),
    ]));
  });

  it("refreshes history without entering an unanswerable HIL state", () => {
    const state = {
      ...emptyChatRuntimeState("pid-1"),
      activeRunId: "run-1",
      runState: "running" as const,
    };

    const result = applyChatSignal(state, "proc.run.hil.requested", {
      pid: "pid-1",
      requestId: "hil-legacy",
      runId: "run-1",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      args: { input: "ls", target: "gsv" },
      createdAt: 1,
    }, { pid: "pid-1" });

    expect(result.matched).toBe(true);
    expect(result.refreshHistory).toBe(true);
    expect(result.state).toBe(state);
    expect(result.state.runState).toBe("running");
    expect(result.state.pendingHil).toBeNull();
  });

  it("uses stream partial snapshots as authoritative assistant text", () => {
    let state = emptyChatRuntimeState("pid-1");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "world",
        partial: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: {
        type: "text_delta",
        contentIndex: 0,
        delta: "!",
        partial: {
          content: [{ type: "text", text: "Hello world!" }],
        },
      },
    }, { pid: "pid-1" }).state;

    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        runId: "run-1",
        text: "Hello world!",
        streaming: true,
      }),
    ]));

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: {
        type: "text_delta",
        contentIndex: 2,
        delta: " Later block.",
        partial: {
          content: [
            { type: "text", text: "Hello world!" },
            { type: "toolCall", name: "Read", arguments: {} },
            { type: "text", text: " Later block." },
          ],
        },
      },
    }, { pid: "pid-1" }).state;

    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        runId: "run-1",
        text: "Hello world! Later block.",
        streaming: true,
      }),
    ]));
  });

  it("drops stream fallback tool rows when a concrete tool starts", () => {
    let state = emptyChatRuntimeState("pid-1");

    state = applyChatSignal(state, "proc.run.started", {
      pid: "pid-1",
      runId: "run-1",
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.run.stream", {
      pid: "pid-1",
      runId: "run-1",
      event: {
        type: "toolcall_start",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          name: "Shell",
          arguments: { input: "pwd" },
        },
      },
    }, { pid: "pid-1" }).state;

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
      callId: "call-1",
      name: "Shell",
      syscall: "shell.exec",
      args: { input: "pwd" },
    }, { pid: "pid-1" }).state;

    expect(state.rows.filter((row) => row.toolCallId === "run-1:tool:0")).toHaveLength(0);
    expect(state.rows.filter((row) => row.role === "tool" || row.role === "toolResult")).toEqual([
      expect.objectContaining({
        role: "tool",
        status: "running",
        toolCallId: "call-1",
      }),
    ]);
  });

  it("requests a typed delta without decoding compatibility message signals", () => {
    let state = addOptimisticUserMessage(
      emptyChatRuntimeState("pid-1"),
      "hello",
    );
    state = addOptimisticUserMessage(state, "hello");

    const reduction = applyChatSignal(state, "proc.changed", {
      pid: "pid-1",
      changes: ["messages"],
      role: "user",
      content: "hello",
      messageId: 42,
      timestamp: Date.now(),
    }, { pid: "pid-1" });
    state = reduction.state;
    expect(reduction.refreshHistory).toBe(true);

    expect(state.rows.filter((row) => row.role === "user" && row.text === "hello")).toHaveLength(2);
    expect(state.rows.some((row) => row.id === "message:42")).toBe(false);
    expect(state.rows.filter((row) => row.id.startsWith("optimistic:user:"))).toHaveLength(2);
  });

  it("normalizes context state from a gateway without token-budget fields", () => {
    const state = applyChatSignal(emptyChatRuntimeState("pid-1"), "proc.changed", {
      pid: "pid-1",
      changes: ["context"],
      context: {
        provider: "openai",
        model: "gpt-5",
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        estimatedInputTokens: 400,
        inputTokens: 400,
        availableInputTokens: 900,
        pressure: 400 / 900,
        level: "ok",
        source: "provider",
        updatedAt: 100,
      },
    }, { pid: "pid-1" }).state;

    expect(state.context).toMatchObject({
      revision: 0,
      confirmedInputTokens: 400,
      estimatedTrailingInputTokens: 0,
      inputBudgetTokens: 900,
      remainingInputTokens: 500,
    });
  });

  it("does not let a stale context signal replace a newer snapshot", () => {
    const context = {
      provider: "openai",
      model: "gpt-5",
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
      estimatedInputTokens: 400,
      inputTokens: 400,
      confirmedInputTokens: 400,
      estimatedTrailingInputTokens: 0,
      inputBudgetTokens: 900,
      remainingInputTokens: 500,
      availableInputTokens: 900,
      pressure: 400 / 900,
      level: "ok",
      source: "provider",
    };
    let state = applyChatSignal(emptyChatRuntimeState("pid-1"), "proc.changed", {
      pid: "pid-1",
      changes: ["context"],
      context: { ...context, revision: 2, updatedAt: 200 },
    }, { pid: "pid-1" }).state;

    state = applyChatSignal(state, "proc.changed", {
      pid: "pid-1",
      changes: ["context"],
      context: {
        ...context,
        revision: 1,
        inputTokens: 100,
        confirmedInputTokens: 100,
        remainingInputTokens: 800,
        updatedAt: 300,
      },
    }, { pid: "pid-1" }).state;

    expect(state.context).toMatchObject({
      revision: 2,
      inputTokens: 400,
      remainingInputTokens: 500,
      updatedAt: 200,
    });
    expect(state.contextRevision).toBe(2);
  });

  it("accepts a revisioned empty history snapshot after reset", () => {
    const current = {
      context: {
        revision: 2,
        provider: "openai",
        model: "gpt-5",
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        estimatedInputTokens: 400,
        inputTokens: 400,
        confirmedInputTokens: 400,
        estimatedTrailingInputTokens: 0,
        inputBudgetTokens: 900,
        remainingInputTokens: 500,
        availableInputTokens: 900,
        pressure: 400 / 900,
        level: "ok" as const,
        source: "provider" as const,
        updatedAt: 200,
      },
      contextRevision: 2,
    };

    const tombstone = {
      context: null,
      contextRevision: 2,
    };
    expect(newerContextSnapshot(current, tombstone)).toEqual({
      context: null,
      contextRevision: 2,
    });
    expect(newerContextSnapshot(tombstone, current)).toBe(tombstone);
    expect(newerContextSnapshot(current, {
      context: null,
      contextRevision: 1,
    })).toBe(current);
  });
});
