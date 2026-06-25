import { describe, expect, it } from "vitest";
import { buildChatAgentViewModel } from "../../chat/domain/agent";
import type { ChatProcessSummary } from "../../chat/domain/processes";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { buildShellChatAgent } from "./chatAgentModel";

function account(input: Partial<ConsoleAccount> & Pick<ConsoleAccount, "uid" | "username" | "relation">): ConsoleAccount {
  return {
    displayName: input.username,
    runnable: true,
    gecos: "",
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
    expect(agent?.crew?.map((member) => member.id)).toEqual(["account:1001"]);
  });
});
