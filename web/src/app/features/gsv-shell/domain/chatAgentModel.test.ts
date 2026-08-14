import { describe, expect, it } from "vitest";
import {
  buildChatAgentViewModel,
  canStartChatWork,
  chatEmptyState,
  type ChatAgentTaskData,
} from "../../chat/domain/agent";
import type { ChatProcessSummary } from "../../chat/domain/processes";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { buildShellChatAgent } from "./chatAgentModel";

function account(
  input: Partial<ConsoleAccount> & Pick<ConsoleAccount, "uid" | "username" | "relation">,
): ConsoleAccount {
  return {
    displayName: input.username,
    runnable: true,
    gecos: "",
    capabilities: [],
    ...input,
  };
}

function process(
  input: Partial<ChatProcessSummary> & Pick<ChatProcessSummary, "pid" | "uid" | "username">,
): ChatProcessSummary {
  return {
    personal: false,
    interactive: true,
    parentPid: null,
    state: "idle",
    runState: "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label: null,
    title: input.pid,
    createdAt: 1,
    cwd: "/home/aria",
    ...input,
  };
}

function taskSummary(tasks: readonly ChatAgentTaskData[]) {
  return tasks.map((task) => ({
    name: task.name,
    processId: task.processId,
    personal: task.process?.personal,
    status: task.status,
  }));
}

describe("shell chat agent model", () => {
  it("keeps the personal intelligence identity during a specialist work session", () => {
    const home = process({
      pid: "proc:home",
      uid: 1000,
      username: "aria",
      personal: true,
      title: "Home",
      createdAt: 10,
    });
    const work = process({
      pid: "proc:review",
      uid: 1000,
      username: "scout",
      title: "Review release",
      runState: "running",
      createdAt: 20,
    });
    const agent = buildShellChatAgent({
      activeProcess: work,
      accounts: [
        account({ uid: 1001, username: "aria", relation: "personal-agent", displayName: "Xanadu" }),
        account({ uid: 1002, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [work, home],
      config: [],
      ownerUid: 1000,
      statusLabel: "running",
    });
    const view = buildChatAgentViewModel({
      agent,
      title: work.title,
      status: "live",
      statusLabel: "running",
      contextLabel: "process history",
    });

    expect(agent.name).toBe("Xanadu");
    expect(agent.role).toBe("PERSONAL AGENT");
    expect(agent.processId).toBe(work.pid);
    expect(agent.runAs).toBeUndefined();
    expect(agent.crew).toEqual([]);
    expect(canStartChatWork(agent)).toBe(true);
    expect(view.name).toBe("Xanadu");
    expect(view.processId).toBe(work.pid);
    expect(taskSummary(agent.tasks ?? [])).toEqual([
      { name: "Review release", processId: work.pid, personal: false, status: "running" },
    ]);
  });

  it("keeps administration distinct while attaching an existing work process", () => {
    const rootWork = process({
      pid: "proc:root-work",
      uid: 0,
      username: "root",
      title: "Root maintenance",
    });
    const agent = buildShellChatAgent({
      activeProcess: rootWork,
      accounts: [
        account({ uid: 0, username: "root", relation: "self", displayName: "Root" }),
        account({ uid: 1002, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [rootWork],
      config: [],
      ownerUid: 0,
      statusLabel: "idle",
    });

    expect(agent.id).toBe("administration");
    expect(agent.name).toBe("Administration");
    expect(agent.role).toBe("NO PERSONAL INTELLIGENCE");
    expect(agent.activity).toBe("idle");
    expect(agent.processId).toBe(rootWork.pid);
    expect(agent.runAs).toBeUndefined();
    expect(agent.tasks).toEqual([]);
    expect(agent.canStartWork).toBe(false);
    expect(canStartChatWork(agent)).toBe(false);
    expect(chatEmptyState(agent, true)).toEqual({
      title: "No messages yet",
      description: "This conversation has no visible messages yet.",
      showStartAction: false,
    });
  });

  it("fails closed into administration when no personal intelligence or work exists", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 0, username: "root", relation: "self", displayName: "Root" }),
      ],
      chatProcesses: [],
      config: [],
      ownerUid: 0,
      statusLabel: "no process",
    });

    expect(agent.processId).toBeUndefined();
    expect(agent.activity).toBe("Personal intelligence unavailable");
    expect(agent.canStartWork).toBe(false);
    expect(chatEmptyState(agent, false)).toEqual({
      title: "Personal intelligence unavailable",
      description: "This account has no personal intelligence. Chat and new work are unavailable.",
      showStartAction: false,
    });
  });

  it("does not reuse a cached personal account after the viewer becomes unknown", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self" }),
        account({ uid: 1001, username: "aria", relation: "personal-agent", displayName: "Xanadu" }),
      ],
      chatProcesses: [],
      config: [],
      ownerUid: null,
      statusLabel: "no process",
    });

    expect(agent.id).toBe("administration");
    expect(agent.processId).toBeUndefined();
    expect(agent.canStartWork).toBe(false);
  });

  it("shows all owner-visible processes as work without grouping by run-as account", () => {
    const agent = buildShellChatAgent({
      activeProcess: null,
      accounts: [account({ uid: 1001, username: "aria", relation: "personal-agent" })],
      chatProcesses: [
        process({ pid: "proc:aria", uid: 1000, username: "aria", title: "Personal planning" }),
        process({
          pid: "proc:scout",
          uid: 1000,
          username: "scout",
          title: "Specialist research",
          state: "unknown",
        }),
        process({
          pid: "proc:foreign",
          uid: 2000,
          username: "other-agent",
          title: "Foreign work",
        }),
      ],
      config: [],
      ownerUid: 1000,
      statusLabel: "no process",
    });

    expect(agent.tasks?.map((task) => task.name)).toEqual([
      "Personal planning",
      "Specialist research",
    ]);
    expect(agent.tasks?.find((task) => task.processId === "proc:scout")?.status).toBe("error");
  });

  it("uses personal account behavior at home and never emits a run-as spawn override", () => {
    const home = process({
      pid: "proc:home",
      uid: 1000,
      username: "aria",
      personal: true,
    });
    const agent = buildShellChatAgent({
      activeProcess: home,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self" }),
        account({ uid: 1001, username: "aria", relation: "personal-agent", displayName: "Xanadu" }),
      ],
      chatProcesses: [home],
      config: [
        { key: "config/ai/model", value: "system-model", redacted: false },
        { key: "users/1000/ai/model", value: "owner-model", redacted: false },
        { key: "users/1000/ai/reasoning", value: "high", redacted: false },
      ],
      ownerUid: 1000,
      statusLabel: "idle",
    });

    expect(agent.modelLabel).toBe("owner-model");
    expect(agent.modelIsDefault).toBe(true);
    expect(agent.reasoningLabel).toBe("HIGH");
    expect(agent.runAs).toBeUndefined();
  });

  it("shows the active work process behavior without replacing the personal identity", () => {
    const work = process({ pid: "proc:scout", uid: 1000, username: "scout" });
    const agent = buildShellChatAgent({
      activeProcess: work,
      accounts: [
        account({ uid: 1000, username: "sam", relation: "self" }),
        account({ uid: 1001, username: "aria", relation: "personal-agent", displayName: "Xanadu" }),
        account({ uid: 1002, username: "scout", relation: "agent", displayName: "Scout" }),
      ],
      chatProcesses: [work],
      config: [
        { key: "config/ai/model", value: "system-model", redacted: false },
        { key: "users/1002/ai/model", value: "specialist-model", redacted: false },
        { key: "users/1002/ai/reasoning", value: "low", redacted: false },
      ],
      ownerUid: 1000,
      statusLabel: "idle",
    });

    expect(agent.name).toBe("Xanadu");
    expect(agent.modelLabel).toBe("specialist-model");
    expect(agent.reasoningLabel).toBe("LOW");
    expect(agent.runAs).toBeUndefined();
  });
});
