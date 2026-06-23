import { describe, expect, it, vi } from "vitest";
import {
  createMachineNodeToken,
  createConsoleAgent,
  loadConsoleAdapterAccounts,
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
  it("creates driver-scoped node tokens for machine provisioning", async () => {
    const create = vi.fn(async () => ({
      token: {
        tokenId: "tok-1",
        token: "secret-node-token",
        tokenPrefix: "gsv_node",
        uid: 42,
        kind: "node",
        label: "Studio Mac",
        allowedRole: "driver",
        allowedDeviceId: "studio-mac",
        createdAt: 1_700_000_000,
        expiresAt: 1_700_086_400,
      },
    }));

    await expect(createMachineNodeToken({
      sys: {
        token: { create },
      },
    } as any, {
      deviceId: "studio-mac",
      label: "Studio Mac",
      expiresAt: 1_700_086_400,
    })).resolves.toEqual({
      tokenId: "tok-1",
      token: "secret-node-token",
      tokenPrefix: "gsv_node",
      uid: 42,
      kind: "node",
      label: "Studio Mac",
      allowedRole: "driver",
      allowedDeviceId: "studio-mac",
      createdAt: 1_700_000_000,
      expiresAt: 1_700_086_400,
    });
    expect(create).toHaveBeenCalledWith({
      kind: "node",
      allowedRole: "driver",
      allowedDeviceId: "studio-mac",
      label: "Studio Mac",
      expiresAt: 1_700_086_400,
    });
  });

  it("loads adapter accounts from adapter discovery", async () => {
    const call = vi.fn(async (syscall: string) => {
      expect(syscall).toBe("adapter.list");
      return {
        adapters: [
          {
            adapter: "whatsapp",
            available: true,
            accounts: [
              {
                accountId: "primary",
                connected: true,
                authenticated: true,
                mode: "websocket",
                lastActivity: 100,
              },
            ],
          },
          {
            adapter: "discord",
            available: true,
            accounts: [],
          },
        ],
      };
    });

    await expect(loadConsoleAdapterAccounts({ call } as any)).resolves.toEqual([
      {
        adapter: "whatsapp",
        accountId: "primary",
        connected: true,
        authenticated: true,
        mode: "websocket",
        lastActivity: 100,
        error: "",
      },
    ]);
    expect(call).toHaveBeenCalledWith("adapter.list", {});
  });

  it("falls back to known adapter status calls when discovery is unavailable", async () => {
    const call = vi.fn(async (syscall: string, args: { adapter?: string }) => {
      if (syscall === "adapter.list") {
        throw new Error("unsupported syscall");
      }
      return {
        adapter: args.adapter,
        accounts: args.adapter === "discord"
          ? [
              {
                accountId: "bot",
                connected: false,
                authenticated: true,
                mode: "gateway",
                error: "offline",
              },
            ]
          : [],
      };
    });

    await expect(loadConsoleAdapterAccounts({ call } as any)).resolves.toEqual([
      {
        adapter: "discord",
        accountId: "bot",
        connected: false,
        authenticated: true,
        mode: "gateway",
        lastActivity: null,
        error: "offline",
      },
    ]);
    expect(call).toHaveBeenCalledWith("adapter.status", { adapter: "whatsapp" });
    expect(call).toHaveBeenCalledWith("adapter.status", { adapter: "discord" });
    expect(call).toHaveBeenCalledWith("adapter.status", { adapter: "telegram" });
  });

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
