import { describe, expect, it, vi } from "vitest";
import {
  createConsoleAgent,
  saveConsoleAgentBehavior,
} from "./consoleService";

function createMockClient(uid: number | string = 42) {
  const createAccount = vi.fn(async () => ({
    account: {
      uid,
      username: "scout-agent",
    },
  }));
  const setConfig = vi.fn(async () => undefined);

  return {
    client: {
      account: {
        create: createAccount,
      },
      sys: {
        config: {
          set: setConfig,
        },
      },
    } as unknown as Parameters<typeof createConsoleAgent>[0],
    createAccount,
    setConfig,
  };
}

describe("console agent service", () => {
  it("persists selected behavior config when creating an agent", async () => {
    const { client, createAccount, setConfig } = createMockClient(42);
    const approval = JSON.stringify({ default: "deny", rules: [] });

    await createConsoleAgent(client, {
      name: "Scout Agent",
      role: "SCOUT",
      description: "Tracks fleet signals.",
      model: "NEMOTRON 3",
      approval,
      files: [
        {
          label: "PERSONA",
          content: "# Persona\n\nWatch the perimeter.",
          orig: "",
        },
        {
          label: "OPERATING NOTES",
          content: "# Notes\n\nPrefer concise reports.",
          orig: "",
        },
      ],
    });

    expect(createAccount).toHaveBeenCalledWith({
      kind: "agent",
      username: "scout-agent",
      gecos: "Scout Agent",
      persona: "Role: SCOUT\n\n# Persona\n\nWatch the perimeter.",
      contextFiles: [{ name: "operating-notes.md", text: "# Notes\n\nPrefer concise reports." }],
    });
    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "users/42/ai/model",
      value: "NEMOTRON 3",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/tools/approval",
      value: approval,
    });
  });

  it("does not create blank behavior overrides when new agent settings inherit defaults", async () => {
    const { client, setConfig } = createMockClient(42);

    await createConsoleAgent(client, {
      name: "Default Agent",
      role: "AGENT",
      description: "",
      model: "",
      approval: "",
      files: [],
    });

    expect(setConfig).not.toHaveBeenCalled();
  });

  it("allows manage saves to clear behavior overrides", async () => {
    const { client, setConfig } = createMockClient(42);

    await saveConsoleAgentBehavior(client, {
      uid: 42,
      model: "",
      approval: "",
    });

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "users/42/ai/model",
      value: "",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/tools/approval",
      value: "",
    });
  });
});
