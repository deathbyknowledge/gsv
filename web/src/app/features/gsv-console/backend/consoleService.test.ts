import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import {
  checkConsoleOpenAiCodexOAuth,
  connectConsoleAdapter,
  consumeIdentityLinkCode,
  createMachineNodeToken,
  createConsoleAgent,
  loadConsoleIdentityLinks,
  loadConsoleAdapterAccounts,
  loadConsoleAdapters,
  pollConsoleOpenAiCodexOAuth,
  removeIdentityLink,
  runConsoleProcessAction,
  saveConsoleConfig,
  saveConsoleConfigEntries,
  saveConsoleAgentBehavior,
  saveConsoleAgentContext,
  startConsoleOpenAiCodexOAuth,
  validateConsoleModelConfig,
} from "./consoleService";

function createMockClient(uid = 42) {
  const createAccount = vi.fn<GSVClient["account"]["create"]>(async () => ({
    kind: "agent",
    account: {
      uid,
      gid: uid,
      gids: [uid],
      username: "scout-agent",
      home: "/home/scout-agent",
      cwd: "/home/scout-agent",
    },
  }));
  const setConfig = vi.fn<GSVClient["sys"]["config"]["set"]>(async () => ({ ok: true }));

  const client = {
      account: {
        create: createAccount,
      },
      sys: {
        config: {
          set: setConfig,
        },
      },
  } satisfies Parameters<typeof createConsoleAgent>[0];
  return {
    client,
    createAccount,
    setConfig,
  };
}

describe("console agent service", () => {
  it("preserves the public adapter QR challenge contract", async () => {
    const result = {
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      ok: true as const,
      adapter: "whatsapp",
      accountId: "default",
      connected: false,
      authenticated: false,
      challenge: {
        type: "qr",
        data: "sensitive-provider-payload",
        // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
        format: "raw" as const,
        expiresAt: 1_800_000_000_000,
        extra: { refreshAfter: 30_000 },
      },
    };
    const call = vi.fn(async () => result);

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(connectConsoleAdapter({ call } as any, {
      adapter: " whatsapp ",
      accountId: " default ",
    })).resolves.toEqual(result);
    expect(call).toHaveBeenCalledWith("adapter.connect", {
      adapter: "whatsapp",
      accountId: "default",
    });
  });

  it("rejects malformed connect responses without serializing QR payloads", async () => {
    const call = vi.fn(async () => ({
      ok: true,
      adapter: "whatsapp",
      accountId: "default",
      connected: false,
      authenticated: false,
      challenge: {
        type: "qr",
        data: "do-not-expose-this-qr-payload",
        format: "html",
      },
    }));

    let caught: Error | null = null;
    try {
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      await connectConsoleAdapter({ call } as any, {
        adapter: "whatsapp",
        accountId: "default",
      });
    } catch (error) {
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      caught = error as Error;
    }
    expect(caught?.message).toBe("Adapter returned an invalid connection response");
    expect(caught?.message).not.toContain("do-not-expose");
  });

  it("creates machine tokens bound to a peer id for machine provisioning", async () => {
    const create = vi.fn(async () => ({
      token: {
        tokenId: "tok-1",
        token: "secret-node-token",
        tokenPrefix: "gsv_node",
        uid: 42,
        kind: "machine",
        label: "Studio Mac",
        peerId: "studio-mac",
        createdAt: 1_700_000_000,
        expiresAt: 1_700_086_400,
      },
    }));

    // SAFETY: Test fixture uses the asserted API shape for this focused case.
    await expect(createMachineNodeToken({
      sys: {
        token: { create },
      },
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    } as any, {
      deviceId: "studio-mac",
      label: "Studio Mac",
      expiresAt: 1_700_086_400,
    })).resolves.toEqual({
      tokenId: "tok-1",
      token: "secret-node-token",
      tokenPrefix: "gsv_node",
      uid: 42,
      kind: "machine",
      label: "Studio Mac",
      peerId: "studio-mac",
      createdAt: 1_700_000_000,
      expiresAt: 1_700_086_400,
    });
    expect(create).toHaveBeenCalledWith({
      kind: "machine",
      peerId: "studio-mac",
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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(loadConsoleAdapters({ call } as any)).resolves.toEqual([
      {
        adapter: "telegram",
        available: true,
        supportsConnect: true,
        supportsDisconnect: false,
        supportsSend: true,
        supportsStatus: false,
        supportsActivity: false,
        supportsPairing: false,
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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

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

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

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
    expect(call).toHaveBeenCalledWith("adapter.status", { adapter: "slack" });
  });

  it("refreshes one adapter account directly during pairing", async () => {
    const call = vi.fn(async () => ({
      adapter: "whatsapp",
      accounts: [{
        accountId: "secondary",
        connected: true,
        authenticated: true,
      }],
    }));

    await expect(loadConsoleAdapterAccounts(
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      { call } as any,
      ["whatsapp"],
      "secondary",
    )).resolves.toEqual([
      expect.objectContaining({
        adapter: "whatsapp",
        accountId: "secondary",
        connected: true,
        authenticated: true,
      }),
    ]);
    expect(call).toHaveBeenCalledWith("adapter.status", {
      adapter: "whatsapp",
      accountId: "secondary",
    });
  });

  it("persists selected behavior config when creating an agent", async () => {
    const { client, createAccount, setConfig } = createMockClient(42);
    const approval = JSON.stringify({ default: "deny", rules: [] });

    await createConsoleAgent(client, {
      name: "Scout Agent",
      role: "SCOUT",
      description: "Tracks fleet signals.",
      model: "model-entry:nemotron-3",
      reasoning: "high",
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
      key: "users/42/ai/preferred_model",
      value: "nemotron-3",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/tools/approval",
      value: approval,
    });
    expect(setConfig).toHaveBeenNthCalledWith(3, {
      key: "users/42/ai/reasoning",
      value: "high",
    });
  });

  it("does not create blank behavior overrides when new agent settings inherit defaults", async () => {
    const { client, setConfig } = createMockClient(42);

    await createConsoleAgent(client, {
      name: "Default Agent",
      role: "AGENT",
      description: "",
      model: "",
      reasoning: "",
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
      reasoning: "",
      approval: "",
    });

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "users/42/ai/preferred_model",
      value: "",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/tools/approval",
      value: "",
    });
    expect(setConfig).toHaveBeenNthCalledWith(3, {
      key: "users/42/ai/reasoning",
      value: "",
    });
  });

  it("rejects raw model names that are not stable entry references", async () => {
    const { client, setConfig } = createMockClient(42);

    await expect(saveConsoleAgentBehavior(client, {
      uid: 42,
      model: "NEMOTRON 3",
      reasoning: "medium",
    })).rejects.toThrow("model selection must reference an available model entry");
    expect(setConfig).not.toHaveBeenCalled();
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("persists selected models as stable entry references", async () => {
    const { client, setConfig } = createMockClient(42);

    await saveConsoleAgentBehavior(client, {
      uid: 42,
      model: "model-entry:fast-stack",
      reasoning: "medium",
    });

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "users/42/ai/preferred_model",
      value: "fast-stack",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/reasoning",
      value: "medium",
    });
    expect(setConfig).toHaveBeenCalledTimes(2);
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("does not persist a second per-agent fallback selector", async () => {
    const { client, setConfig } = createMockClient(42);

    await saveConsoleAgentBehavior(client, {
      uid: 42,
      model: "model-entry:fast-stack",
      reasoning: "medium",
    });

    expect(setConfig).toHaveBeenNthCalledWith(1, {
      key: "users/42/ai/preferred_model",
      value: "fast-stack",
    });
    expect(setConfig).toHaveBeenNthCalledWith(2, {
      key: "users/42/ai/reasoning",
      value: "medium",
    });
    expect(setConfig).toHaveBeenCalledTimes(2);
    expect(setConfig).not.toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringContaining("fallback"),
    }));
  });

  it("reconciles renamed and deleted agent context files", async () => {
    const call = vi.fn(async () => ({ ok: true }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(saveConsoleAgentContext({ call } as any, {
      username: "scout-agent",
      baseNames: ["old-notes.md", "remove-me.md"],
      files: [
        {
          label: "renamed-notes.md",
          name: "renamed-notes.md",
          origName: "old-notes.md",
          content: "# Notes\n\nUpdated.",
          orig: "# Notes\n\nOriginal.",
        },
      ],
    })).resolves.toEqual({ written: 1, deleted: 2 });

    expect(call).toHaveBeenNthCalledWith(1, "fs.write", {
      path: "/home/scout-agent/context.d/renamed-notes.md",
      content: "# Notes\n\nUpdated.",
    });
    expect(call).toHaveBeenNthCalledWith(2, "fs.delete", {
      path: "/home/scout-agent/context.d/old-notes.md",
    });
    expect(call).toHaveBeenNthCalledWith(3, "fs.delete", {
      path: "/home/scout-agent/context.d/remove-me.md",
    });
  });

  it("writes newly added agent context files even when seeded from a draft", async () => {
    const call = vi.fn(async () => ({ ok: true }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(saveConsoleAgentContext({ call } as any, {
      username: "scout-agent",
      baseNames: [],
      files: [
        {
          label: "UNTITLED",
          name: "new-plan.md",
          content: "# Untitled\n\n",
        },
      ],
    })).resolves.toEqual({ written: 1, deleted: 0 });

    expect(call).toHaveBeenCalledWith("fs.write", {
      path: "/home/scout-agent/context.d/new-plan.md",
      content: "# Untitled\n\n",
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

  it("starts OpenAI Codex OAuth through the device-code syscall", async () => {
    const call = vi.fn(async () => ({
      flow: {
        flowId: "flow-1",
        uid: 42,
        kind: "ai-provider",
        provider: "openai-codex",
        accountKey: "default",
        label: "OpenAI Codex",
        authorizationEndpoint: "https://auth.openai.com/codex/device",
        tokenEndpoint: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        redirectUri: "https://auth.openai.com/deviceauth/callback",
        scope: "openid profile email offline_access",
        resource: null,
        createdAt: 1,
        expiresAt: 901,
      },
      provider: "openai-codex",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
      expiresAt: 901,
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(startConsoleOpenAiCodexOAuth({ call } as any))
      .resolves.toMatchObject({
        provider: "openai-codex",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
      });
    expect(call).toHaveBeenCalledWith("sys.oauth.device.start", {
      kind: "ai-provider",
      provider: "openai-codex",
    });
  });

  it("polls OpenAI Codex OAuth through the device-code syscall", async () => {
    const call = vi.fn(async () => ({
      status: "pending",
      flow: {
        flowId: "flow-1",
        uid: 42,
        kind: "ai-provider",
        provider: "openai-codex",
        accountKey: "default",
        label: "OpenAI Codex",
        authorizationEndpoint: "https://auth.openai.com/codex/device",
        tokenEndpoint: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        redirectUri: "https://auth.openai.com/deviceauth/callback",
        scope: "openid profile email offline_access",
        resource: null,
        createdAt: 1,
        expiresAt: 901,
      },
      intervalSeconds: 5,
      expiresAt: 901,
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(pollConsoleOpenAiCodexOAuth({ call } as any, { flowId: "flow-1" }))
      .resolves.toMatchObject({
        status: "pending",
        intervalSeconds: 5,
      });
    expect(call).toHaveBeenCalledWith("sys.oauth.device.poll", {
      flowId: "flow-1",
    });
  });

  it("checks whether OpenAI Codex OAuth is already connected", async () => {
    const call = vi.fn(async () => ({
      accounts: [
        {
          uid: 42,
          kind: "ai-provider",
          provider: "openai-codex",
          accountKey: "default",
          label: "OpenAI Codex",
          scope: "openid profile email offline_access",
          resource: null,
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          tokenType: "Bearer",
          expiresAt: 1_700_000_000,
          createdAt: 1,
          updatedAt: 2,
          lastUsedAt: null,
          metadata: { chatgptAccountId: "chatgpt-account-1" },
        },
      ],
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(checkConsoleOpenAiCodexOAuth({ call } as any)).resolves.toEqual({ connected: true });
    expect(call).toHaveBeenCalledWith("sys.oauth.list", {});
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("treats OpenAI Codex OAuth without account metadata as disconnected", async () => {
    const call = vi.fn(async () => ({
      accounts: [
        {
          uid: 42,
          kind: "ai-provider",
          provider: "openai-codex",
          accountKey: "default",
          label: "OpenAI Codex",
          scope: "openid profile email offline_access",
          resource: null,
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          tokenType: "Bearer",
          expiresAt: 1_700_000_000,
          createdAt: 1,
          updatedAt: 2,
          lastUsedAt: null,
          metadata: {},
        },
      ],
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(checkConsoleOpenAiCodexOAuth({ call } as any)).resolves.toEqual({ connected: false });
  });

  it("validates text model settings without disabling configured reasoning", async () => {
    const call = vi.fn(async () => ({
      provider: "anthropic",
      model: "claude-test",
      text: "ok",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "anthropic",
        model: "claude-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(validateConsoleModelConfig({ call } as any, {
      values: {
        "config/ai/provider": " anthropic ",
        "config/ai/model": " claude-test ",
        "config/ai/api_key": " sk-live ",
        "config/ai/reasoning": " high ",
        "config/ai/max_context_bytes": "12345",
      },
    })).resolves.toEqual({
      ok: true,
      provider: "anthropic",
      model: "claude-test",
    });

    expect(call).toHaveBeenCalledWith("ai.text.generate", expect.objectContaining({
      config: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-test",
          apiKey: "sk-live",
        },
        reasoning: "high",
      },
      options: {
        maxTokens: 2_048,
        timeoutMs: 30_000,
      },
      sessionAffinityKey: "gsv-console:model-validation",
    }));
  });

  it("validates OpenAI Codex model settings through live generation", async () => {
    const call = vi.fn(async () => ({
      provider: "openai-codex",
      model: "gpt-5.5",
      text: "ok",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(validateConsoleModelConfig({ call } as any, {
      values: {
        "config/ai/provider": " openai-codex ",
        "config/ai/model": " gpt-5.5 ",
      },
    })).resolves.toEqual({
      ok: true,
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(call).toHaveBeenCalledWith("ai.text.generate", expect.objectContaining({
      config: {
        modelConfig: {
          provider: "openai-codex",
          model: "gpt-5.5",
        },
      },
      sessionAffinityKey: "gsv-console:model-validation",
    }));
  });

  it("sanitizes HTML block pages from model validation errors", async () => {
    const call = vi.fn(async () => {
      throw new Error("<html><body><p>Unable to load site</p><span>Ray ID:a1663d565f5cfeb1</span></body></html>");
    });

    let caught: Error | null = null;
    try {
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      await validateConsoleModelConfig({ call } as any, {
        values: {
          "config/ai/provider": "anthropic",
          "config/ai/model": "claude-test",
        },
      });
    } catch (error) {
      // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
      caught = error as Error;
    }

    expect(caught?.message).toContain("Provider returned an HTML challenge or block page");
    expect(caught?.message).not.toContain("<html>");
    expect(caught?.message).not.toContain("Ray ID");
  });

  it("validates saved models by stable entry id", async () => {
    const call = vi.fn(async () => ({
      provider: "workers-ai",
      model: "@cf/test/model",
      text: "ok",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "workers-ai",
        model: "@cf/test/model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await validateConsoleModelConfig({ call } as any, {
      modelId: "fast-stack",
      values: {
        "config/ai/provider": "workers-ai",
        "config/ai/model": "@cf/test/model",
      },
    });

    expect(call).toHaveBeenCalledWith("ai.text.generate", expect.objectContaining({
      config: {
        modelId: "fast-stack",
        modelConfig: {
          provider: "workers-ai",
          model: "@cf/test/model",
        },
      },
    }));
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("validates an explicit API key clear in the complete model", async () => {
    const call = vi.fn(async () => ({
      provider: "workers-ai",
      model: "@cf/test/model",
      text: "ok",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "workers-ai",
        model: "@cf/test/model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await validateConsoleModelConfig({ call } as any, {
      modelId: "fast-stack",
      values: {
        "config/ai/provider": "workers-ai",
        "config/ai/model": "@cf/test/model",
        "config/ai/api_key": "",
      },
    });

    expect(call).toHaveBeenCalledWith("ai.text.generate", expect.objectContaining({
      config: {
        modelId: "fast-stack",
        modelConfig: {
          provider: "workers-ai",
          model: "@cf/test/model",
          apiKey: "",
        },
      },
    }));
  });

  // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

  it("validates a complete model without inheriting a stored base URL", async () => {
    const call = vi.fn(async () => ({
      provider: "custom",
      model: "local-chat",
      text: "ok",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "test",
        provider: "custom",
        model: "local-chat",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await validateConsoleModelConfig({ call } as any, {
      modelId: "local",
      values: {
        "config/ai/provider": "custom",
        "config/ai/model": "local-chat",
        "config/ai/base_url": "",
      },
    });

    expect(call).toHaveBeenCalledWith("ai.text.generate", expect.objectContaining({
      config: {
        modelId: "local",
        modelConfig: {
          provider: "custom",
          model: "local-chat",
        },
      },
    }));
  });

  it("rejects model validation errors without echoing secrets", async () => {
    const call = vi.fn(async () => ({
      provider: "anthropic",
      model: "claude-test",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "anthropic",
        model: "claude-test",
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "bad key sk-secret-value",
      },
    }));

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(validateConsoleModelConfig({ call } as any, {
      values: {
        "config/ai/provider": "anthropic",
        "config/ai/model": "claude-test",
        "config/ai/api_key": "sk-secret-value",
      },
    })).rejects.toThrow("bad key redacted");
  });

  it("runs process actions through proc syscalls", async () => {
    const abort = vi.fn(async () => ({ ok: true, pid: "proc-1", aborted: true }));
    const reset = vi.fn(async () => ({ ok: true, pid: "proc-1", archivedMessages: 2, archives: [] }));
    const kill = vi.fn(async () => ({ ok: true, pid: "proc-1", archivedMessages: 2, archives: [] }));
    const client = {
      proc: { abort, reset, kill },
    };

    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.

    await expect(runConsoleProcessAction(client as any, {
      pid: " proc-1 ",
      runId: "run-1",
      action: "abort",
    })).resolves.toEqual({
      ok: true,
      action: "abort",
      pid: "proc-1",
    });
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    await expect(runConsoleProcessAction(client as any, { pid: "proc-1", action: "reset" })).resolves.toEqual({
      ok: true,
      action: "reset",
      pid: "proc-1",
    });
    // SAFETY: Test fixture data is constructed with the asserted shape for this focused case.
    await expect(runConsoleProcessAction(client as any, { pid: "proc-1", action: "kill" })).resolves.toEqual({
      ok: true,
      action: "kill",
      pid: "proc-1",
    });

    expect(abort).toHaveBeenCalledWith({ pid: "proc-1", runId: "run-1" });
    expect(reset).toHaveBeenCalledWith({ pid: "proc-1" });
    expect(kill).toHaveBeenCalledWith({ pid: "proc-1", archive: true });
  });
});
