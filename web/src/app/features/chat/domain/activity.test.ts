import { describe, expect, it } from "vitest";
import { deriveChatLiveActivity } from "./activity";
import { emptyChatRuntimeState } from "./transcript";

describe("chat live activity", () => {
  it("prioritizes pending approvals over generic running state", () => {
    const state = {
      ...emptyChatRuntimeState("pid-1", "default"),
      activeRunId: "run-1",
      pendingHil: {
        requestId: "hil-1",
        runId: "run-1",
        conversationId: "default",
        callId: "call-1",
        toolName: "Shell",
        syscall: "shell.exec",
        args: { input: "npm test" },
        createdAt: 1,
      },
      runState: "awaiting_hil" as const,
    };

    expect(deriveChatLiveActivity(state)).toMatchObject({
      activity: "Awaiting approval: Running npm test",
      runStateLabel: "awaiting approval",
      status: "warn",
      statusLabel: "awaiting approval",
    });
  });

  it("describes the latest running tool for the active run", () => {
    const state = {
      ...emptyChatRuntimeState("pid-1", "default"),
      activeRunId: "run-1",
      runState: "running" as const,
      rows: [
        {
          id: "tool:call-1",
          role: "tool" as const,
          text: "{}",
          time: "",
          timestamp: 1,
          runId: "run-1",
          status: "running" as const,
          toolArgs: { path: "/tmp/design.md" },
          toolCallId: "call-1",
          toolName: "Read",
          toolSyscall: "fs.read",
        },
      ],
    };

    expect(deriveChatLiveActivity(state)).toMatchObject({
      activity: "Reading design.md",
      runStateLabel: "using tools",
      status: "live",
      statusLabel: "using tools",
    });
  });

  it("distinguishes thinking from writing reply while streaming", () => {
    const thinking = {
      ...emptyChatRuntimeState("pid-1", "default"),
      activeRunId: "run-1",
      runState: "running" as const,
      rows: [
        {
          id: "assistant:run-1",
          role: "assistant" as const,
          text: "",
          thinking: ["checking context"],
          time: "",
          timestamp: 1,
          runId: "run-1",
          status: "streaming" as const,
          streaming: true,
        },
      ],
    };

    expect(deriveChatLiveActivity(thinking)).toMatchObject({
      activity: "Thinking",
      runStateLabel: "thinking",
      statusLabel: "thinking",
    });

    expect(deriveChatLiveActivity({
      ...thinking,
      rows: [{ ...thinking.rows[0], text: "Here is" }],
    })).toMatchObject({
      activity: "Writing reply",
      runStateLabel: "writing reply",
      statusLabel: "writing reply",
    });
  });
});
