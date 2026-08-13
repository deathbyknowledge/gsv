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
  it("hands an exact completed stream presentation to its durable history row", () => {
    const streamed = row({
      id: "assistant:run-adopt",
      presentationKey: "live-assistant:run-adopt:100:1",
      role: "assistant",
      text: "A **stable** answer",
      media: [{ key: "media-1", mimeType: "image/png", type: "image" }],
      runId: "run-adopt",
      status: "done",
      streaming: false,
      timestamp: 100,
    });
    const durable = row({
      id: "message:91",
      role: "assistant",
      text: "A **stable** answer",
      media: [{ key: "media-1", mimeType: "image/png", type: "image" }],
      messageId: 91,
      runId: "run-adopt",
      status: "done",
      timestamp: 101,
    });

    const adopted = mergeTranscriptRows([streamed], [durable]);
    expect(adopted).toMatchObject([{
      id: "message:91",
      presentationKey: "live-assistant:run-adopt:100:1",
    }]);

    const refreshed = mergeTranscriptRows(adopted, [{ ...durable }]);
    expect(refreshed).toMatchObject([{
      id: "message:91",
      presentationKey: "live-assistant:run-adopt:100:1",
    }]);
  });

  it("does not use run identity to adopt a partial, changed, or ambiguous response", () => {
    const transient = row({
      id: "assistant:run-shared",
      presentationKey: "live-assistant:run-shared:100:2",
      role: "assistant",
      text: "Current answer",
      runId: "run-shared",
      status: "done",
      streaming: false,
      timestamp: 100,
    });
    const stale = row({
      id: "message:90",
      role: "assistant",
      text: "Earlier answer",
      messageId: 90,
      runId: "run-shared",
      status: "done",
      timestamp: 90,
    });
    const changed = mergeTranscriptRows([transient], [stale]);
    expect(changed).toHaveLength(2);
    expect(changed.find((candidate) => candidate.id === "message:90")?.presentationKey).toBeUndefined();

    const stillStreaming = { ...transient, streaming: true, status: "streaming" as const };
    const sameBody = { ...stale, id: "message:91", messageId: 91, text: transient.text };
    const partial = mergeTranscriptRows([stillStreaming], [sameBody]);
    expect(partial).toHaveLength(2);
    expect(partial.find((candidate) => candidate.id === "message:91")?.presentationKey).toBeUndefined();

    const duplicate = mergeTranscriptRows([transient], [
      sameBody,
      { ...sameBody, id: "message:92", messageId: 92 },
    ]);
    expect(duplicate).toHaveLength(3);
    expect(duplicate.filter((candidate) => candidate.id.startsWith("message:"))
      .every((candidate) => candidate.presentationKey === undefined)).toBe(true);
  });

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

  it("keeps live running tool rows over stale persisted planning rows", () => {
    const startedAt = 1_782_600_000_000;
    const currentRows = [
      row({
        id: "tool:call-codemode",
        role: "tool",
        text: "Running CodeMode",
        runId: "run-1",
        status: "running",
        timestamp: startedAt + 100,
        toolArgs: { code: "for (const device of devices) await inspect(device)" },
        toolCallId: "call-codemode",
        toolName: "CodeMode",
        toolSyscall: "codemode.exec",
      }),
    ];
    const nextRows = [
      row({
        id: "tool:call-codemode",
        role: "tool",
        text: "Preparing CodeMode",
        messageId: 2,
        runId: "run-1",
        status: "planning",
        timestamp: startedAt,
        toolArgs: { code: "for (const device of devices) await inspect(device)" },
        toolCallId: "call-codemode",
        toolName: "CodeMode",
        toolSyscall: "codemode.exec",
      }),
    ];

    expect(mergeTranscriptRows(currentRows, nextRows)).toMatchObject([
      {
        id: "tool:call-codemode",
        role: "tool",
        status: "running",
        toolCallId: "call-codemode",
      },
    ]);
  });

  it("lets completed tool results replace live running tool rows", () => {
    const startedAt = 1_782_600_000_000;
    const currentRows = [
      row({
        id: "tool:call-codemode",
        role: "tool",
        text: "Running CodeMode",
        runId: "run-1",
        status: "running",
        timestamp: startedAt,
        toolArgs: { code: "for (const device of devices) await inspect(device)" },
        toolCallId: "call-codemode",
        toolName: "CodeMode",
        toolSyscall: "codemode.exec",
      }),
    ];
    const nextRows = [
      row({
        id: "tool:call-codemode",
        role: "toolResult",
        text: "done",
        messageId: 3,
        runId: "run-1",
        status: "done",
        timestamp: startedAt + 1_000,
        toolCallId: "call-codemode",
        toolName: "CodeMode",
        toolOutput: { status: "completed" },
        toolSyscall: "codemode.exec",
      }),
    ];

    expect(mergeTranscriptRows(currentRows, nextRows)).toMatchObject([
      {
        id: "tool:call-codemode",
        role: "toolResult",
        status: "done",
        toolCallId: "call-codemode",
      },
    ]);
  });

  it("keeps same fallback tool ids from different runs separate", () => {
    const startedAt = 1_782_600_000_000;
    const currentRows = [
      row({
        id: "tool:workers-ai-tool-1",
        role: "toolResult",
        text: "done",
        messageId: 2,
        runId: "run-1",
        status: "done",
        timestamp: startedAt,
        toolCallId: "workers-ai-tool-1",
        toolName: "Read",
        toolOutput: { content: "old" },
      }),
    ];
    const nextRows = [
      row({
        id: "tool:workers-ai-tool-1",
        role: "tool",
        text: "Preparing Read",
        messageId: 4,
        runId: "run-2",
        status: "planning",
        timestamp: startedAt + 1_000,
        toolArgs: { path: "/tmp/new.txt" },
        toolCallId: "workers-ai-tool-1",
        toolName: "Read",
      }),
    ];

    expect(mergeTranscriptRows(currentRows, nextRows).map((item) => ({
      role: item.role,
      runId: item.runId,
      status: item.status,
      toolCallId: item.toolCallId,
    }))).toEqual([
      {
        role: "toolResult",
        runId: "run-1",
        status: "done",
        toolCallId: "workers-ai-tool-1",
      },
      {
        role: "tool",
        runId: "run-2",
        status: "planning",
        toolCallId: "workers-ai-tool-1",
      },
    ]);
  });
});
