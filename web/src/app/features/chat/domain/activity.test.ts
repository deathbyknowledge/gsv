import { describe, expect, it } from "vitest";
import { applyChatLiveActivityToAgent, deriveChatLiveActivity } from "./activity";
import { emptyChatRuntimeState } from "./transcript";

describe("chat live activity", () => {
  it("prioritizes a requested stop until the active run reconciles", () => {
    const state = {
      ...emptyChatRuntimeState("pid-1", "default"),
      activeRunId: "run-1",
      runState: "running" as const,
    };

    expect(deriveChatLiveActivity(state, true)).toMatchObject({
      activity: "Stopping",
      runStateLabel: "stopping",
      status: "update",
      statusLabel: "stopping",
    });
  });

  it("prioritizes pending approvals over generic running state", () => {
    const state = {
      ...emptyChatRuntimeState("pid-1", "default"),
      activeRunId: "run-1",
      pendingHil: {
        pid: "pid-1",
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
      statusLabel: "thinking",
    });

    expect(deriveChatLiveActivity({
      ...thinking,
      rows: [{ ...thinking.rows[0], text: "Here is" }],
    })).toMatchObject({
      activity: "Writing reply",
      statusLabel: "writing reply",
    });
  });

  it("updates live status without replacing the agent process task list", () => {
    const agent = {
      activity: "RUNNING",
      status: "live" as const,
      statusLabel: "RUNNING",
      tasksTotal: 2,
      tasks: [
        { name: "Active build", processId: "proc:active", status: "running" as const },
        { name: "Queued review", processId: "proc:queued", status: "running" as const },
      ],
    };
    const patched = applyChatLiveActivityToAgent(agent, {
      activity: "Reading package.json",
      agentStatus: "live",
      status: "live",
      statusLabel: "using tools",
      tasks: [{ name: "Reading package.json", status: "running" }],
    }, "proc:active");

    expect(patched).toMatchObject({
      activity: "Reading package.json",
      statusLabel: "using tools",
      tasksTotal: 2,
      tasks: agent.tasks,
    });
  });
});
