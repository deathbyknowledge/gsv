import { describe, expect, it } from "vitest";
import type { ChatProcessSummary } from "../chat/domain/processes";
import type { ChatRuntimeState, ChatTranscriptRow } from "../chat/domain/transcript";
import {
  chooseLatestInteractiveProcess,
  projectTextMoments,
} from "./model";

function row(
  input: Partial<ChatTranscriptRow> & Pick<ChatTranscriptRow, "id" | "role" | "text">,
): ChatTranscriptRow {
  return {
    time: "",
    timestamp: null,
    status: "done",
    ...input,
  };
}

function runtime(
  rows: ChatTranscriptRow[],
  input: Partial<ChatRuntimeState> = {},
): ChatRuntimeState {
  return {
    activeRunId: null,
    context: null,
    messageCount: rows.length,
    pendingHil: null,
    rows,
    runState: "idle",
    streamSequences: {},
    ...input,
  };
}

function process(
  input: Partial<ChatProcessSummary> & Pick<ChatProcessSummary, "pid" | "createdAt" | "interactive">,
): ChatProcessSummary {
  return {
    uid: 1,
    username: "alice",
    parentPid: null,
    state: "idle",
    runState: "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: null,
    title: input.pid,
    cwd: "/home/alice",
    ...input,
  };
}

describe("text moment projection", () => {
  it("keeps visible transcript order while omitting transport-only rows", () => {
    const attachment = { type: "image", key: "media-1" };
    const projection = projectTextMoments(runtime([
      row({ id: "user-1", role: "user", text: "First", media: [attachment] }),
      row({ id: "tool-1", role: "toolResult", text: "raw output", toolName: "Read" }),
      row({ id: "thinking-1", role: "assistant", text: "", status: "thinking", streaming: true }),
      row({ id: "assistant-1", role: "assistant", text: "Second" }),
      row({ id: "system-1", role: "system", text: "Third", isError: true }),
    ]));

    expect(projection.moments.map((moment) => ({
      key: moment.key,
      role: moment.role,
      text: moment.text,
      streaming: moment.streaming,
      error: moment.error,
    }))).toEqual([
      { key: "moment:user-1", role: "user", text: "First", streaming: false, error: false },
      { key: "moment:assistant-1", role: "assistant", text: "Second", streaming: false, error: false },
      { key: "moment:system-1", role: "system", text: "Third", streaming: false, error: true },
    ]);
    expect(projection.moments[0].media).toEqual([attachment]);
  });

  it("collapses in-flight tools into sanitized category activity", () => {
    const projection = projectTextMoments(runtime([
      row({ id: "user-1", role: "user", text: "Please work", runId: "run-1" }),
      row({
        id: "tool-read-1",
        role: "tool",
        text: "{ private args }",
        runId: "run-1",
        status: "running",
        toolArgs: { path: "/private/first.txt" },
        toolCallId: "read-1",
        toolName: "Read",
        toolSyscall: "fs.read",
      }),
      row({
        id: "tool-read-2",
        role: "tool",
        text: "{ more private args }",
        runId: "run-1",
        status: "planning",
        toolArgs: { path: "/private/second.txt" },
        toolCallId: "read-2",
        toolName: "Read",
      }),
      row({
        id: "tool-shell",
        role: "tool",
        text: "rm private-file",
        runId: "run-1",
        status: "running",
        toolArgs: { command: "rm /private/file" },
        toolCallId: "shell-1",
        toolName: "Shell",
      }),
      row({
        id: "thinking-1",
        role: "assistant",
        text: "",
        runId: "run-1",
        status: "thinking",
        streaming: true,
        thinking: ["private chain of thought"],
      }),
    ], {
      activeRunId: "run-1",
      runState: "running",
    }));

    expect(projection.moments.map((moment) => moment.role)).toEqual(["user"]);
    expect(projection.activityLines).toEqual([
      {
        key: "activity:run:run-1:reading-files",
        category: "reading-files",
        count: 2,
        text: "Running 2 read operations…",
      },
      {
        key: "activity:run:run-1:running-commands",
        category: "running-commands",
        count: 1,
        text: "Running a command…",
      },
    ]);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("chain of thought");
    expect(serialized).not.toContain("rm private-file");
  });

  it("projects a reasoning-only stream as thinking activity", () => {
    const projection = projectTextMoments(runtime([
      row({
        id: "assistant-thinking",
        role: "assistant",
        text: "",
        runId: "run-1",
        status: "thinking",
        streaming: true,
        thinking: ["do not surface this"],
      }),
    ], {
      activeRunId: "run-1",
      runState: "running",
    }));

    expect(projection.moments).toEqual([]);
    expect(projection.activityLines).toEqual([{
      key: "activity:run:run-1:thinking",
      category: "thinking",
      count: 1,
      text: "Thinking…",
    }]);
  });

  it("keeps a streaming assistant as a visible moment without exposing thinking", () => {
    const media = [{ type: "image", key: "image-1" }];
    const projection = projectTextMoments(runtime([
      row({ id: "user-1", role: "user", text: "Hello", runId: "run-1" }),
      row({
        id: "assistant-1",
        role: "assistant",
        text: "Partial answer",
        media,
        runId: "run-1",
        status: "streaming",
        streaming: true,
        thinking: ["private reasoning"],
      }),
    ], {
      activeRunId: "run-1",
      runState: "running",
    }));

    expect(projection.moments[1]).toMatchObject({
      key: "moment:assistant-1",
      role: "assistant",
      text: "Partial answer",
      media,
      streaming: true,
      error: false,
    });
    expect(projection.activityLines).toEqual([]);
    expect(JSON.stringify(projection)).not.toContain("private reasoning");
  });

  it("uses a reconciled presentation key instead of remounting a durable response", () => {
    const projection = projectTextMoments(runtime([
      row({
        id: "message:91",
        presentationKey: "live-assistant:run-adopt:100:1",
        role: "assistant",
        text: "A stable answer",
        runId: "run-adopt",
      }),
    ]));

    expect(projection.moments[0].key).toBe("moment:live-assistant:run-adopt:100:1");
  });

  it("attaches successful completed work to the following assistant moment", () => {
    const projection = projectTextMoments(runtime([
      row({ id: "user-1", role: "user", text: "Inspect it", runId: "run-1" }),
      row({
        id: "read-1",
        role: "toolResult",
        text: "secret contents",
        runId: "run-1",
        status: "done",
        toolCallId: "read-1",
        toolName: "Read",
        toolOutput: "/private/a",
      }),
      row({
        id: "read-2",
        role: "toolResult",
        text: "more secret contents",
        runId: "run-1",
        status: "done",
        toolCallId: "read-2",
        toolName: "Read",
        toolOutcome: "completed",
      }),
      row({
        id: "shell-failed",
        role: "toolResult",
        text: "private failure",
        runId: "run-1",
        status: "error",
        isError: true,
        toolCallId: "shell-1",
        toolName: "Shell",
        toolOutcome: "failed",
      }),
      row({ id: "assistant-1", role: "assistant", text: "Done.", runId: "run-1" }),
    ]));

    expect(projection.moments).toHaveLength(2);
    expect(projection.moments[1].completedWork).toEqual([{
      key: "moment:assistant-1:work:reading-files",
      category: "reading-files",
      count: 2,
      text: "Read files 2 times",
    }]);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("secret contents");
    expect(serialized).not.toContain("/private/a");
    expect(serialized).not.toContain("private failure");
  });
});

describe("latest interactive process", () => {
  it("chooses the most recently active interactive process without mutating input", () => {
    const processes = [
      process({ pid: "interactive-old", interactive: true, createdAt: 10, lastActiveAt: 20 }),
      process({ pid: "background-new", interactive: false, createdAt: 100, lastActiveAt: 100 }),
      process({ pid: "interactive-new", interactive: true, createdAt: 80 }),
    ];
    const order = processes.map((entry) => entry.pid);

    expect(chooseLatestInteractiveProcess(processes)?.pid).toBe("interactive-new");
    expect(processes.map((entry) => entry.pid)).toEqual(order);
    expect(chooseLatestInteractiveProcess([])).toBeNull();
  });
});
