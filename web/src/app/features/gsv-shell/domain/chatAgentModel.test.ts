import { describe, expect, it } from "vitest";
import { buildChatAgentViewModel, type ChatAgentTaskData } from "../../chat/domain/agent";
import type { ChatProcessSummary } from "../../chat/domain/processes";
import type { ConsoleAccount, ConsoleProcess } from "../../gsv-console/domain/consoleModels";
import { buildShellChatAgent } from "./chatAgentModel";

function account(input: Partial<ConsoleAccount> & Pick<ConsoleAccount, "uid" | "username" | "relation">): ConsoleAccount {
  return {
    displayName: input.username,
    runnable: true,
    gecos: "",
    capabilities: [],
    ...input,
  };
}

function process(input: Partial<ChatProcessSummary> & Pick<ChatProcessSummary, "pid" | "uid" | "username">): ChatProcessSummary {
  return {
    interactive: true,
    parentPid: null,
    state: "idle",
    runState: "idle",
    activeRunId: null,
    activeConversationId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: null,
    title: input.pid,
    createdAt: 1,
    cwd: "/home/scout",
    isDefaultConversation: false,
    ...input,
  };
}

function consoleProcess(input: Partial<ConsoleProcess> & Pick<ConsoleProcess, "pid" | "uid" | "username">): ConsoleProcess {
  return {
    label: input.pid,
    state: "idle",
    rawState: "idle",
    profile: "task",
    cwd: "/home/scout",
    parentPid: null,
    interactive: true,
    activeRunId: null,
    activeConversationId: null,
    queuedCount: 0,
    createdAt: 1,
    lastActiveAt: null,
    ...input,
  };
}

function taskSummary(tasks: readonly ChatAgentTaskData[]) {
  return tasks.map((task) => ({
    name: task.name,
    processId: task.processId,
    status: task.status,
  }));
}

describe("shell chat agent model", () => {
  it("keeps an account-backed custom agent startable without inventing a process id", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" })],
      chatProcesses: [],
      config: [],
      consoleProcesses: [],
      statusLabel: "no process",
    });

    const view = buildChatAgentViewModel({
      agent,
      title: "Chat",
      status: "idle",
      statusLabel: "no process",
      contextLabel: "no history",
    });

    expect(agent?.runAs).toBe("scout");
    expect(agent?.processId).toBeUndefined();
    expect(view.runAs).toBe("scout");
    expect(view.processId).toBe("");
  });

  it("lets the default personal agent inherit the gateway spawn identity", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [account({ uid: 8, username: "xanadu", relation: "personal-agent", displayName: "Xanadu" })],
      chatProcesses: [],
      config: [],
      consoleProcesses: [],
      statusLabel: "no process",
    });

    expect(agent?.runAs).toBeUndefined();
  });

  it("uses the selected account as the draft chat agent", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" }),
        account({ uid: 9, username: "builder", relation: "agent", displayName: "Builder" }),
      ],
      chatProcesses: [],
      config: [],
      consoleProcesses: [],
      selectedAgentId: "account:9",
      statusLabel: "no process",
    });

    const view = buildChatAgentViewModel({
      agent,
      title: "Chat",
      status: "idle",
      statusLabel: "no process",
      contextLabel: "no history",
    });

    expect(agent?.id).toBe("account:9");
    expect(agent?.name).toBe("Builder");
    expect(agent?.runAs).toBe("builder");
    expect(view.crew.find((member) => member.id === "account:9")?.active).toBe(true);
    expect(view.crew.find((member) => member.id === "account:9")?.startable).toBe(true);
  });

  it("lists visible console processes for an account-backed agent", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" }),
        account({ uid: 9, username: "builder", relation: "agent", displayName: "Builder" }),
      ],
      chatProcesses: [],
      config: [],
      consoleProcesses: [
        consoleProcess({ pid: "proc:idle", uid: 7, username: "scout", label: "Idle research", createdAt: 10 }),
        consoleProcess({ pid: "proc:run", uid: 7, username: "scout", label: "Active build", state: "running", activeRunId: "run-1", createdAt: 5 }),
        consoleProcess({ pid: "proc:other", uid: 9, username: "builder", label: "Other agent" }),
      ],
      selectedAgentId: "account:7",
      statusLabel: "no process",
    });

    expect(agent?.tasksTotal).toBe(2);
    expect(taskSummary(agent?.tasks ?? [])).toEqual([
      { name: "Active build", processId: "proc:run", status: "running" },
      { name: "Idle research", processId: "proc:idle", status: "idle" },
    ]);
    expect(agent?.tasks?.[0]?.process?.pid).toBe("proc:run");
    expect(agent?.activity).toBe("RUNNING");
  });

  it("uses the process id only for process-backed active chat", () => {
    const activeProcess = process({ pid: "proc:scout", uid: 7, username: "scout" });
    const agent = buildShellChatAgent({
      activeProcess,
      accounts: [account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" })],
      chatProcesses: [activeProcess],
      config: [],
      consoleProcesses: [],
      statusLabel: "idle",
    });

    const view = buildChatAgentViewModel({
      agent,
      title: "Chat",
      status: "idle",
      statusLabel: "idle",
      contextLabel: "no history",
    });

    expect(agent?.processId).toBe("proc:scout");
    expect(view.processId).toBe("proc:scout");
    expect(view.runAs).toBe("scout");
  });

  it("keeps all console processes for the active agent in the task list", () => {
    const activeProcess = process({ pid: "proc:active", uid: 7, username: "scout", title: "Active chat" });
    const agent = buildShellChatAgent({
      activeProcess,
      accounts: [account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" })],
      chatProcesses: [activeProcess],
      config: [],
      consoleProcesses: [
        consoleProcess({ pid: "proc:active", uid: 7, username: "scout", label: "Active chat", createdAt: 20 }),
        consoleProcess({ pid: "proc:queued", uid: 7, username: "scout", label: "Queued review", queuedCount: 2, createdAt: 30 }),
        consoleProcess({ pid: "proc:other", uid: 8, username: "builder", label: "Other agent" }),
      ],
      statusLabel: "idle",
    });

    expect(agent?.tasksTotal).toBe(2);
    expect(agent?.tasks?.map((task) => task.processId)).toEqual(["proc:active", "proc:queued"]);
    expect(agent?.tasks?.map((task) => task.name)).toEqual(["Active chat", "Queued review"]);
    expect(agent?.statusLabel).toBe("idle");
    expect(agent?.activity).toBe("idle");
  });

  it("does not group unrelated owner-owned processes when no agent account is resolved", () => {
    const activeProcess = process({
      pid: "proc:pkg",
      uid: 1000,
      username: "pkg#builder",
      title: "Package build",
    });
    const agent = buildShellChatAgent({
      activeProcess,
      accounts: [account({ uid: 1000, username: "sam", relation: "self", displayName: "Sam" })],
      chatProcesses: [activeProcess],
      config: [],
      consoleProcesses: [
        consoleProcess({ pid: "proc:scout", uid: 1000, username: "scout", label: "Scout task" }),
      ],
      statusLabel: "idle",
    });

    expect(taskSummary(agent?.tasks ?? [])).toEqual([
      { name: "Package build", processId: "proc:pkg", status: "idle" },
    ]);
  });

  it("keeps the active chat task when console overview is stale", () => {
    const activeProcess = process({ pid: "proc:new", uid: 7, username: "scout", title: "New task" });
    const agent = buildShellChatAgent({
      activeProcess,
      accounts: [account({ uid: 7, username: "scout", relation: "agent", displayName: "Scout" })],
      chatProcesses: [activeProcess],
      config: [],
      consoleProcesses: [
        consoleProcess({ pid: "proc:old", uid: 7, username: "scout", label: "Older task", createdAt: 30 }),
      ],
      statusLabel: "idle",
    });

    expect(taskSummary(agent?.tasks ?? [])).toEqual([
      { name: "New task", processId: "proc:new", status: "idle" },
      { name: "Older task", processId: "proc:old", status: "idle" },
    ]);
    expect(agent?.tasks?.[1]?.process).toMatchObject({
      pid: "proc:old",
      title: "Older task",
      username: "scout",
    });
  });

  it("uses the owner model override as an inherited default for agent chats", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self", displayName: "Sam" }),
        account({ uid: 1001, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [],
      config: [
        { key: "config/ai/model", value: "system-model", redacted: false },
        { key: "config/ai/reasoning", value: "medium", redacted: false },
        { key: "users/1000/ai/model", value: "owner-model", redacted: false },
        { key: "users/1000/ai/reasoning", value: "high", redacted: false },
      ],
      consoleProcesses: [],
      sessionUsername: "sam",
      statusLabel: "no process",
    });

    expect(agent?.modelLabel).toBe("owner-model");
    expect(agent?.modelValue).toBe("");
    expect(agent?.modelIsDefault).toBe(true);
    expect(agent?.modelOptions?.[0]).toBe("owner-model");
    expect(agent?.reasoningLabel).toBe("HIGH");
  });

  it("prefers an agent model override over the owner model override", () => {
    const activeProcess = process({ pid: "proc:scout", uid: 1001, username: "scout" });
    const agent = buildShellChatAgent({
      activeProcess,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self", displayName: "Sam" }),
        account({ uid: 1001, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [activeProcess],
      config: [
        { key: "config/ai/model", value: "system-model", redacted: false },
        { key: "config/ai/reasoning", value: "medium", redacted: false },
        { key: "users/1000/ai/model", value: "owner-model", redacted: false },
        { key: "users/1000/ai/reasoning", value: "high", redacted: false },
        { key: "users/1001/ai/model", value: "agent-model", redacted: false },
        { key: "users/1001/ai/reasoning", value: "low", redacted: false },
      ],
      consoleProcesses: [],
      sessionUsername: "sam",
      statusLabel: "idle",
    });

    expect(agent?.modelLabel).toBe("agent-model");
    expect(agent?.modelValue).toBe("agent-model");
    expect(agent?.modelIsDefault).toBe(false);
    expect(agent?.modelOptions).toEqual(["owner-model", "system-model", "agent-model"]);
    expect(agent?.reasoningLabel).toBe("LOW");
  });

  it("exposes viewer model profiles instead of raw model config fields", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self", displayName: "Sam" }),
        account({ uid: 1001, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [],
      config: [
        {
          key: "config/ai/image/read/model",
          value: "vision-model",
          redacted: false,
        },
        {
          key: "users/1000/ai/model_profiles",
          value: JSON.stringify({
            profiles: [
              {
                id: "fast-stack",
                name: "Fast Stack",
                values: {
                  "config/ai/provider": "openai",
                  "config/ai/model": "gpt-4.1-mini",
                  "config/ai/api_key": "secret",
                },
                createdAt: 10,
                updatedAt: 20,
              },
            ],
          }),
          redacted: false,
        },
      ],
      consoleProcesses: [],
      sessionUsername: "sam",
      statusLabel: "no process",
    });

    expect(agent?.modelProfiles).toEqual([
      expect.objectContaining({
        id: "fast-stack",
        name: "Fast Stack",
        values: expect.objectContaining({
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-4.1-mini",
        }),
      }),
    ]);
    expect(agent?.modelOptions).toContain("gpt-4.1-mini");
    expect(agent?.modelOptions).not.toContain("vision-model");
    expect(agent?.crew?.map((member) => member.id)).toEqual(["account:1001"]);
  });
});
