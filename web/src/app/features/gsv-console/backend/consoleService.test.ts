import { describe, expect, it, vi } from "vitest";
import {
  consumeIdentityLinkCode,
  createMachineNodeToken,
  createConsoleAgent,
  loadConsoleIdentityLinks,
  loadConsoleAdapterAccounts,
  loadConsoleAdapters,
  removeIdentityLink,
  runConsoleProcessAction,
  saveConsoleConfig,
  saveConsoleConfigEntries,
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
        extra: {},
      },
    ]);
    expect(call).toHaveBeenCalledWith("adapter.list", {});
  });

  it("loads deployed adapter inventory including empty account lists", async () => {
    const call = vi.fn(async () => ({
      adapters: [
        {
          adapter: "telegram",
          available: true,
          supportsConnect: true,
          supportsSend: true,
          accounts: [],
        },
      ],
    }));

    await expect(loadConsoleAdapters({ call } as any)).resolves.toEqual([
      {
        adapter: "telegram",
        available: true,
        supportsConnect: true,
        supportsDisconnect: false,
        supportsSend: true,
        supportsStatus: false,
        supportsShellExec: false,
        supportsActivity: false,
        accounts: [],
      },
    ]);
  });

  it("loads identity links from the kernel", async () => {
    const call = vi.fn(async () => ({
      links: [
        {
          adapter: "discord",
          accountId: "main",
          actorId: "u-2",
          uid: 2,
          createdAt: 20,
          linkedByUid: 0,
        },
        {
          adapter: "whatsapp",
          accountId: "primary",
          actorId: "u-1",
          uid: 1,
          createdAt: 30,
          linkedByUid: 1,
        },
      ],
    }));

    await expect(loadConsoleIdentityLinks({ call } as any)).resolves.toEqual([
      {
        adapter: "whatsapp",
        accountId: "primary",
        actorId: "u-1",
        uid: 1,
        createdAt: 30,
        linkedByUid: 1,
      },
      {
        adapter: "discord",
        accountId: "main",
        actorId: "u-2",
        uid: 2,
        createdAt: 20,
        linkedByUid: 0,
      },
    ]);
    expect(call).toHaveBeenCalledWith("sys.link.list", {});
  });

  it("redeems identity link codes", async () => {
    const call = vi.fn(async () => ({
      linked: true,
      link: {
        adapter: "discord",
        accountId: "main",
        actorId: "external-user",
        uid: 42,
        createdAt: 100,
      },
    }));

    await expect(consumeIdentityLinkCode({ call } as any, { code: " abc123 " })).resolves.toEqual({
      linked: true,
      link: {
        adapter: "discord",
        accountId: "main",
        actorId: "external-user",
        uid: 42,
        createdAt: 100,
        linkedByUid: null,
      },
    });
    expect(call).toHaveBeenCalledWith("sys.link.consume", { code: "abc123" });
  });

  it("removes identity links", async () => {
    const call = vi.fn(async () => ({ removed: true }));

    await expect(removeIdentityLink({ call } as any, {
      adapter: " Discord ",
      accountId: " main ",
      actorId: " actor-1 ",
    })).resolves.toEqual({ removed: true });
    expect(call).toHaveBeenCalledWith("sys.unlink", {
      adapter: "discord",
      accountId: "main",
      actorId: "actor-1",
    });
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
        extra: {},
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

  it("saves generic config entries without trimming values", async () => {
    const { client, setConfig } = createMockClient(42);

    await expect(saveConsoleConfig(client, {
      key: " config/ai/model ",
      value: "  provider/model\n",
    })).resolves.toEqual({
      ok: true,
      key: "config/ai/model",
      value: "  provider/model\n",
    });

    expect(setConfig).toHaveBeenCalledWith({
      key: "config/ai/model",
      value: "  provider/model\n",
    });
  });

  it("requires a config key when saving generic config", async () => {
    const { client, setConfig } = createMockClient(42);

    await expect(saveConsoleConfig(client, {
      key: " ",
      value: "value",
    })).rejects.toThrow("config key is required");

    expect(setConfig).not.toHaveBeenCalled();
  });

  it("saves grouped config entries in order", async () => {
    const { client, setConfig } = createMockClient(42);

    await expect(saveConsoleConfigEntries(client, {
      entries: [
        { key: "config/ai/provider", value: "workers-ai" },
        { key: "config/ai/model", value: "@cf/test/model" },
      ],
    })).resolves.toEqual({ ok: true, written: 2 });

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "config/ai/provider",
      value: "workers-ai",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "config/ai/model",
      value: "@cf/test/model",
    });
  });

  it("runs process actions through proc syscalls", async () => {
    const abort = vi.fn(async () => ({ ok: true, pid: "proc-1", aborted: true }));
    const reset = vi.fn(async () => ({ ok: true, pid: "proc-1", archivedMessages: 2, archives: [] }));
    const kill = vi.fn(async () => ({ ok: true, pid: "proc-1", archivedMessages: 2, archives: [] }));
    const client = {
      proc: { abort, reset, kill },
    };

    await expect(runConsoleProcessAction(client as any, { pid: " proc-1 ", action: "abort" })).resolves.toEqual({
      ok: true,
      action: "abort",
      pid: "proc-1",
    });
    await expect(runConsoleProcessAction(client as any, { pid: "proc-1", action: "reset" })).resolves.toEqual({
      ok: true,
      action: "reset",
      pid: "proc-1",
    });
    await expect(runConsoleProcessAction(client as any, { pid: "proc-1", action: "kill" })).resolves.toEqual({
      ok: true,
      action: "kill",
      pid: "proc-1",
    });

    expect(abort).toHaveBeenCalledWith({ pid: "proc-1" });
    expect(reset).toHaveBeenCalledWith({ pid: "proc-1" });
    expect(kill).toHaveBeenCalledWith({ pid: "proc-1", archive: true });
  });
});
