import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";
import type { OAuthAccountRecord } from "./oauth-store";
import { sendFrameToProcess } from "../shared/utils";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";

const generateMock = vi.hoisted(() => vi.fn());
const createGenerationServiceMock = vi.hoisted(() => vi.fn((_options?: unknown) => ({
  generate: generateMock,
  stream: vi.fn(),
  generateText: vi.fn(),
})));

vi.mock("../inference/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../inference/service")>();
  return {
    ...actual,
    createGenerationService: createGenerationServiceMock,
  };
});

import {
  handleAiConfig,
  handleAiImageGenerate,
  handleAiImageRead,
  handleAiSpeechCreate,
  handleAiTextGenerate,
  handleAiTools,
  handleAiTranscriptionCreate,
} from "./ai";
import { DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "../inference/transcription";
import {
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_SPEAKER,
} from "../inference/speech";
import {
  DEFAULT_IMAGE_READING_INPUT_FORMAT,
  DEFAULT_IMAGE_READING_MAX_TOKENS,
  DEFAULT_IMAGE_READING_MODEL,
  DEFAULT_IMAGE_READING_PROMPT,
} from "../inference/image-reading";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "../inference/capabilities";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

beforeEach(() => {
  sendFrameToProcessMock.mockReset();
  generateMock.mockReset();
  createGenerationServiceMock.mockClear();
});

function makeDevice(partial: Partial<DeviceRecord> & { device_id: string }): DeviceRecord {
  const now = 1_800_000_000_000;
  return {
    device_id: partial.device_id,
    owner_uid: partial.owner_uid ?? 1000,
    label: partial.label ?? partial.device_id,
    description: partial.description ?? "",
    implements: partial.implements ?? ["shell.exec"],
    platform: partial.platform ?? "linux",
    version: partial.version ?? "1.0.0",
    online: partial.online ?? true,
    first_seen_at: partial.first_seen_at ?? now,
    last_seen_at: partial.last_seen_at ?? now,
    connected_at: partial.connected_at ?? now,
    disconnected_at: partial.disconnected_at ?? null,
  };
}

function makeContext(
  connectionState: string,
  options: {
    uid?: number;
    ownerUid?: number;
    processId?: string;
    capabilities?: string[];
  } = {},
): KernelContext {
  const uid = options.uid ?? 1000;
  const ownerUid = options.ownerUid ?? uid;
  const mcpRecord = {
    serverId: "server-1",
    uid: ownerUid,
    name: "Search",
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 2000 ? "friday" : "sam",
        home: uid === 2000 ? "/home/friday" : "/home/sam",
        cwd: uid === 2000 ? "/home/friday" : "/home/sam",
      },
      capabilities: options.capabilities ?? ["*"],
    },
    processId: options.processId,
    procs: {
      getOwnerUid: vi.fn((processId: string) =>
        processId === options.processId ? ownerUid : null
      ),
    },
    devices: {
      listForUser: vi.fn(() => []),
    },
    auth: {
      getPasswdByUid: vi.fn((lookupUid: number) => lookupUid === uid
        ? {
          username: uid === 2000 ? "friday" : "sam",
          uid,
          gid: uid,
          gecos: "",
          home: uid === 2000 ? "/home/friday" : "/home/sam",
          shell: "/bin/init",
        }
        : null),
    },
    adapters: {
      identityLinks: { list: vi.fn(() => []) },
      status: {
        listByOwner: vi.fn(() => []),
        list: vi.fn(() => []),
        listAll: vi.fn(() => []),
      },
    },
    mcpServers: {
      list: vi.fn((lookupUid?: number) => lookupUid === mcpRecord.uid ? [mcpRecord] : []),
    },
    mcp: {
      mcpConnections: {
        "server-1": { connectionState },
      },
      listTools: vi.fn(() => [{
        serverId: "server-1",
        name: "lookup",
        description: "Look up records",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
        },
      }]),
    },
  } as unknown as KernelContext;
}

function attachProcessAiSnapshot(
  ctx: KernelContext,
  values: Record<string, string>,
  pid = "proc:test",
  profile?: { id?: string; name?: string; appliedAt: number },
): KernelContext {
  (ctx as { processId?: string }).processId = pid;
  (ctx as { procs?: { getOwnerUid: ReturnType<typeof vi.fn> } }).procs = {
    getOwnerUid: vi.fn(() => ctx.identity?.process.uid ?? 1000),
  };
  sendFrameToProcessMock.mockResolvedValueOnce({
    type: "res",
    id: "proc-ai-config",
    ok: true,
    data: {
      ok: true,
      pid,
      config: {
        version: 1,
        values,
        ...(profile ? { profile } : {}),
        updatedAt: 1,
      },
    },
  });
  return ctx;
}

describe("handleAiTools", () => {
  it("keeps the direct LLM tool surface to the fixed Linux-like toolset", async () => {
    const ctx = makeContext("ready");

    const result = await handleAiTools(ctx);
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames).toEqual([
      "Read",
      "Write",
      "Edit",
      "Delete",
      "Search",
      "Shell",
      "CodeMode",
    ]);
    expect(
      result.tools.every((tool) =>
        !tool.name.startsWith("MCP_") &&
        !tool.name.includes("Spawn") &&
        !tool.name.includes("Schedule") &&
        tool.name !== "Copy"
      ),
      "ai.tools should stay a fixed Linux-like surface: filesystem tools, Shell, and CodeMode only. Do not expose OS conveniences such as spawn, sched, MCP, or copy as direct LLM tools.",
    ).toBe(true);
    expect(result.mcpServers).toEqual(["Search"]);
    const codeModeTool = result.tools.find((tool) => tool.name === "CodeMode");
    expect(codeModeTool?.description).toContain("return mcpTools.map");
    expect(codeModeTool?.description).toContain("inputSchema/outputSchema");
    expect(codeModeTool?.description).not.toContain("declare function lookup");
    expect(ctx.mcp.listTools).not.toHaveBeenCalled();
  });

  it("advertises owner-owned MCP tools for service-account agent processes", async () => {
    const ctx = makeContext("ready", {
      uid: 2000,
      ownerUid: 1000,
      processId: "proc-agent",
    });

    const result = await handleAiTools(ctx);

    expect(result.mcpServers).toEqual(["Search"]);
    expect(ctx.mcpServers.list).toHaveBeenCalledWith(1000);
    const codeModeTool = result.tools.find((tool) => tool.name === "CodeMode");
    expect(codeModeTool?.description).toContain("return mcpTools.map");
    expect(ctx.mcp.listTools).not.toHaveBeenCalled();
  });

  it("does not advertise MCP tools without sys.mcp.call capability", async () => {
    const ctx = makeContext("ready", {
      capabilities: ["codemode.*"],
    });

    const result = await handleAiTools(ctx);

    expect(result.mcpServers).toEqual([]);
    expect(ctx.mcpServers.list).not.toHaveBeenCalled();
    const codeModeTool = result.tools.find((tool) => tool.name === "CodeMode");
    expect(codeModeTool).toBeTruthy();
    expect(codeModeTool?.description).not.toContain("declare function lookup");
  });

  it("keeps the same boundary for non-ready MCP connections", async () => {
    const ctx = makeContext("authenticating");

    const result = await handleAiTools(ctx);

    expect(result.tools.some((tool) => tool.name.startsWith("MCP_"))).toBe(false);
    expect(result.mcpServers).toEqual([]);
    expect(ctx.mcp.listTools).not.toHaveBeenCalled();
  });

  it("caps routable tool target descriptions when many targets are online", async () => {
    const records = Array.from({ length: 12 }, (_value, index) =>
      makeDevice({ device_id: `node-${String(index + 1).padStart(2, "0")}` })
    );
    const ctx = {
      ...makeContext("ready"),
      devices: {
        listForUser: vi.fn(() => records),
      },
    } as unknown as KernelContext;

    const result = await handleAiTools(ctx);
    const shell = result.tools.find((tool) => tool.name === "Shell");
    const description = JSON.stringify(shell?.inputSchema);

    expect(description).toContain("node-01");
    expect(description).toContain("node-10");
    expect(description).toContain("and 2 more");
    expect(description).toContain("targets list");
    expect(description).not.toContain("node-11");
    expect(description).not.toContain("node-12");
  });
});

describe("handleAiConfig", () => {
  function makeAiConfigContext(
    config: Record<string, string> = {},
    options: {
      uid?: number;
      processId?: string;
      ownerUid?: number;
      capabilities?: string[];
      oauthAccounts?: OAuthAccountRecord[];
    } = {},
  ): KernelContext {
    const uid = options.uid ?? 1000;
    const ownerUid = options.ownerUid ?? uid;
    const oauthAccounts = options.oauthAccounts ?? [];
    return {
      identity: {
        role: "user",
        process: {
          uid,
          gid: uid,
          gids: [uid],
          username: uid === 2000 ? "friday" : "sam",
          home: uid === 2000 ? "/home/friday" : "/home/sam",
          cwd: uid === 2000 ? "/home/friday" : "/home/sam",
        },
        capabilities: options.capabilities ?? ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
        getExplicit: vi.fn((key: string) => config[key] ?? null),
        list: vi.fn((prefix: string) => Object.entries(config)
          .filter(([key]) => key.startsWith(`${prefix.replace(/\/$/, "")}/`))
          .map(([key, value]) => ({ key, value }))),
      },
      auth: {
        getPasswdByUid: vi.fn((lookupUid: number) => lookupUid === ownerUid
          ? {
              uid: ownerUid,
              gid: ownerUid,
              username: "sam",
              gecos: "sam",
              home: "/home/sam",
              shell: "/bin/init",
            }
          : null),
        resolveGids: vi.fn((_username: string, gid: number) => [gid]),
      },
      procs: {
        getOwnerUid: vi.fn(() => ownerUid),
      },
      oauth: {
        findAccountByIdentity: vi.fn((
          lookupUid: number,
          kind: string,
          provider: string,
          accountKey: string,
        ) => oauthAccounts.find((account) =>
          account.uid === lookupUid &&
          account.kind === kind &&
          account.provider === provider &&
          account.accountKey === accountKey,
        ) ?? null),
        markAccountUsed: vi.fn(() => true),
        upsertAccount: vi.fn((input) => ({
          accountId: "acct-refresh",
          ...input,
          createdAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_000,
          lastUsedAt: null,
          metadata: input.metadata ?? {},
        })),
      },
      processId: options.processId,
      env: {},
    } as unknown as KernelContext;
  }

  function makeOAuthAccount(partial: Partial<OAuthAccountRecord>): OAuthAccountRecord {
    return {
      accountId: partial.accountId ?? "acct-codex",
      uid: partial.uid ?? 1000,
      kind: partial.kind ?? "ai-provider",
      provider: partial.provider ?? "openai-codex",
      accountKey: partial.accountKey ?? "default",
      label: partial.label ?? "OpenAI Codex",
      scope: partial.scope ?? "openid profile email offline_access",
      resource: partial.resource ?? null,
      clientId: partial.clientId ?? "openai-codex-device",
      tokenType: partial.tokenType ?? "Bearer",
      accessToken: partial.accessToken ?? "codex-access-token",
      refreshToken: partial.refreshToken ?? "codex-refresh-token",
      expiresAt: partial.expiresAt ?? 1_900_000_000_000,
      createdAt: partial.createdAt ?? 1_800_000_000_000,
      updatedAt: partial.updatedAt ?? 1_800_000_000_000,
      lastUsedAt: partial.lastUsedAt ?? null,
      metadata: partial.metadata ?? {},
    };
  }

  function fakeCodexAccessToken(accountId: string): string {
    return fakeJwtToken({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    });
  }

  function fakeJwtToken(payload: Record<string, unknown>): string {
    return [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "sig",
    ].join(".");
  }

  it("resolves the generation streaming switch", async () => {
    await expect(handleAiConfig({}, makeAiConfigContext()))
      .resolves.toMatchObject({ generationStreaming: "auto", system: { timezone: "UTC" } });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/generation/streaming": "off",
      "config/server/timezone": "Europe/Amsterdam",
    }))).resolves.toMatchObject({ generationStreaming: "off" });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/server/timezone": "Europe/Amsterdam",
    }))).resolves.toMatchObject({ system: { timezone: "Europe/Amsterdam" } });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/generation/streaming": "invalid",
    }))).resolves.toMatchObject({ generationStreaming: "auto" });
  });

  it("resolves prompt skill enumeration independently from live skills", async () => {
    await expect(handleAiConfig({}, makeAiConfigContext()))
      .resolves.toMatchObject({ skillIndexMode: "summary" });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/skills/index_mode": "off",
    }))).resolves.toMatchObject({ skillIndexMode: "off", skillIndex: [] });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/skills/index_mode": "off",
      "users/1000/ai/skills/index_mode": "names",
    }))).resolves.toMatchObject({ skillIndexMode: "names" });
  });

  it("returns the text executor for kernel and process callers", async () => {
    await expect(handleAiConfig({}, makeAiConfigContext()))
      .resolves.toMatchObject({ executor: { kind: "kernel" } });
    await expect(handleAiConfig({}, makeAiConfigContext({}, {
      processId: "task-1",
    }))).resolves.toMatchObject({
      executor: {
        kind: "process",
        pid: "task-1",
      },
    });
  });

  it("returns the resolved process capabilities", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({}, {
      capabilities: ["codemode.run", "net.fetch"],
    }));

    expect(result.capabilities).toEqual(["codemode.run", "net.fetch"]);
  });

  it("returns no capabilities for the pre-auth setup assistant", async () => {
    const ctx = makeAiConfigContext();
    delete ctx.identity;

    const result = await handleAiConfig({}, ctx);

    expect(result.capabilities).toEqual([]);
  });

  it("uses a stored OpenAI Codex OAuth account when the provider key is blank", async () => {
    const ctx = makeAiConfigContext({
      "users/1000/ai/provider": "openai-codex",
      "users/1000/ai/model": "gpt-5.5",
    }, {
      oauthAccounts: [
        makeOAuthAccount({
          accessToken: "codex-access-token",
          metadata: { chatgptAccountId: "chatgpt-account-1" },
        }),
      ],
    });

    const result = await handleAiConfig({}, ctx);

    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "codex-access-token",
      openAiCodex: { accountId: "chatgpt-account-1" },
    });
    expect(result.media?.imageGenerationApiKey).toBe("");
    expect(ctx.oauth.findAccountByIdentity).toHaveBeenCalledWith(
      1000,
      "ai-provider",
      "openai-codex",
      "default",
    );
    expect(ctx.oauth.markAccountUsed).toHaveBeenCalledWith("acct-codex", 1000);
  });

  it("uses a stored OpenAI Codex OAuth account when a stale provider key exists", async () => {
    const ctx = makeAiConfigContext({
      "users/1000/ai/provider": "openai-codex",
      "users/1000/ai/model": "gpt-5.5",
      "users/1000/ai/api_key": "stale-codex-token",
    }, {
      oauthAccounts: [
        makeOAuthAccount({
          accessToken: "codex-oauth-access-token",
          metadata: { chatgptAccountId: "chatgpt-account-1" },
        }),
      ],
    });

    const result = await handleAiConfig({}, ctx);

    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "codex-oauth-access-token",
      openAiCodex: { accountId: "chatgpt-account-1" },
    });
    expect(ctx.oauth.findAccountByIdentity).toHaveBeenCalledWith(
      1000,
      "ai-provider",
      "openai-codex",
      "default",
    );
  });

  it("refreshes a stored OpenAI Codex OAuth account to backfill missing account metadata", async () => {
    const accessToken = fakeJwtToken({ sub: "user-1" });
    const refreshedAccessToken = fakeJwtToken({ sub: "user-1" });
    const idToken = fakeCodexAccessToken("chatgpt-account-1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: refreshedAccessToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const ctx = makeAiConfigContext({
      "users/1000/ai/provider": "openai-codex",
      "users/1000/ai/model": "gpt-5.5",
    }, {
      oauthAccounts: [
        makeOAuthAccount({
          accessToken,
          refreshToken: "codex-refresh-token",
          metadata: {},
        }),
      ],
    });

    try {
      const result = await handleAiConfig({}, ctx);
      const refreshBody = fetchSpy.mock.calls[0]?.[1]?.body as URLSearchParams;

      expect(result).toMatchObject({
        provider: "openai-codex",
        model: "gpt-5.5",
        apiKey: refreshedAccessToken,
        openAiCodex: { accountId: "chatgpt-account-1" },
      });
      expect(refreshBody.get("grant_type")).toBe("refresh_token");
      expect(refreshBody.get("refresh_token")).toBe("codex-refresh-token");
      expect(ctx.oauth.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
        accessToken: refreshedAccessToken,
        metadata: expect.objectContaining({
          chatgptAccountId: "chatgpt-account-1",
        }),
      }));
      expect(ctx.oauth.markAccountUsed).toHaveBeenCalledWith("acct-refresh", 1000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the root OpenAI Codex OAuth account for inherited global config", async () => {
    const ctx = makeAiConfigContext({
      "config/ai/provider": "openai-codex",
      "config/ai/model": "gpt-5.5",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
      oauthAccounts: [
        makeOAuthAccount({
          accountId: "acct-user-codex",
          uid: 1000,
          accessToken: "user-codex-access-token",
          metadata: { chatgptAccountId: "chatgpt-user-account" },
        }),
        makeOAuthAccount({
          accountId: "acct-root-codex",
          uid: 0,
          accessToken: "root-codex-access-token",
          metadata: { chatgptAccountId: "chatgpt-root-account" },
        }),
      ],
    });

    const result = await handleAiConfig({}, ctx);

    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "root-codex-access-token",
      openAiCodex: { accountId: "chatgpt-root-account" },
    });
    expect(ctx.oauth.findAccountByIdentity).toHaveBeenCalledWith(
      0,
      "ai-provider",
      "openai-codex",
      "default",
    );
    expect(ctx.oauth.markAccountUsed).toHaveBeenCalledWith("acct-root-codex", 0);
  });

  it("uses the root OpenAI Codex OAuth account for global config even when a stale global key exists", async () => {
    const ctx = makeAiConfigContext({
      "config/ai/provider": "openai-codex",
      "config/ai/model": "gpt-5.5",
      "config/ai/api_key": "stale-root-codex-token",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
      oauthAccounts: [
        makeOAuthAccount({
          accountId: "acct-root-codex",
          uid: 0,
          accessToken: "root-codex-access-token",
          metadata: { chatgptAccountId: "chatgpt-root-account" },
        }),
      ],
    });

    const result = await handleAiConfig({}, ctx);

    expect(result).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "root-codex-access-token",
      openAiCodex: { accountId: "chatgpt-root-account" },
    });
    expect(ctx.oauth.findAccountByIdentity).toHaveBeenCalledWith(
      0,
      "ai-provider",
      "openai-codex",
      "default",
    );
  });

  it("generates text with preset config and explicit generation options", async () => {
    const requestSignal = new AbortController().signal;
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-test",
        apiKey: "preset-secret",
      });
      expect(request.context).toMatchObject({
        systemPrompt: "Be direct.",
        messages: [{
          role: "user",
          content: "ping",
        }],
      });
      expect(request.options).toEqual({
        maxTokens: 64,
        reasoning: "off",
      });
      expect(request.signal).toBe(requestSignal);
      return {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
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
        timestamp: 1,
      };
    });
    const ctx = makeAiConfigContext({
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "preset-1",
          name: "Fast",
          values: {
            "config/ai/provider": "anthropic",
            "config/ai/model": "claude-test",
            "config/ai/api_key": "redacted",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/1000/ai/model_profiles/preset-1/api_key": "preset-secret",
    });

    const result = await handleAiTextGenerate({
      systemPrompt: "Be direct.",
      messages: [{ role: "user", content: "ping" }],
      config: { preset: { name: "Fast" } },
      options: { maxTokens: 64, reasoning: "off" },
    }, {
      ...ctx,
      processId: "task-1",
      requestSignal,
    });

    expect(result).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      text: "pong",
    });
  });

  it("generates text with process snapshot config in the kernel", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-process",
        apiKey: "profile-secret",
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "snapshot pong" }],
        api: "test",
        provider: "anthropic",
        model: "claude-process",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      };
    });

    const result = await handleAiTextGenerate({
      systemPrompt: "Be direct.",
      messages: [{ role: "user", content: "ping" }],
      config: {
        processOverrides: {
          "config/ai/provider": "anthropic",
          "config/ai/model": "claude-process",
        },
        processProfile: {
          id: "fast-stack",
          name: "Fast Stack",
          appliedAt: 1,
        },
      },
    }, makeAiConfigContext({
      "users/1000/ai/model_profiles/fast-stack/api_key": "profile-secret",
    }, {
      processId: "task-1",
    }));

    expect(result).toMatchObject({
      provider: "anthropic",
      model: "claude-process",
      text: "snapshot pong",
    });
  });

  it("preserves explicit blank API key overrides for text generation", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-test",
        apiKey: "",
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
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
        timestamp: 1,
      };
    });

    await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        overrides: {
          "config/ai/provider": "anthropic",
          "config/ai/model": "claude-test",
          "config/ai/api_key": "",
        },
      },
    }, makeAiConfigContext({
      "users/1000/ai/api_key": "saved-key",
    }));
  });

  it("preserves explicit blank base URL overrides for preset text generation", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "custom",
        model: "local-chat",
        providerStyle: "openai-chat-completions",
      });
      expect(request.config.baseUrl).toBeUndefined();
      return {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
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
        timestamp: 1,
      };
    });

    await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        preset: { id: "local" },
        overrides: {
          "config/ai/base_url": "",
        },
      },
    }, makeAiConfigContext({
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "local",
          name: "Local",
          values: {
            "config/ai/provider": "custom",
            "config/ai/model": "local-chat",
            "config/ai/base_url": "http://old.example/v1",
            "config/ai/provider_style": "openai-chat-completions",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
    }));
  });

  it("does not build a routed fetch for non-custom text generation targets", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-test",
        transportTarget: "linux-machine",
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
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
        timestamp: 1,
      };
    });

    const result = await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        overrides: {
          "config/ai/provider": "anthropic",
          "config/ai/model": "claude-test",
          "config/ai/transport_target": "linux-machine",
        },
      },
    }, makeAiConfigContext());

    expect(result.text).toBe("pong");
    expect(createGenerationServiceMock).toHaveBeenCalledWith({});
  });

  it("builds a routed fetch for OpenAI Codex text generation targets", async () => {
    generateMock.mockImplementationOnce(async () => ({
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      api: "test",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    }));
    const device = makeDevice({
      device_id: "linux-machine",
      implements: ["net.fetch"],
    });
    const ctx = {
      ...makeAiConfigContext({}, {
        oauthAccounts: [
          makeOAuthAccount({
            accessToken: "codex-access-token",
            metadata: { chatgptAccountId: "chatgpt-account-1" },
          }),
        ],
      }),
      devices: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => device),
        listForUser: vi.fn(() => [device]),
      },
    } as unknown as KernelContext;

    const result = await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        overrides: {
          "config/ai/provider": "openai-codex",
          "config/ai/model": "gpt-5.4-mini",
          "config/ai/api_key": "",
          "config/ai/transport_target": "linux-machine",
        },
      },
    }, ctx, {
      requestDevice: vi.fn(),
    });

    expect(result.text).toBe("pong");
    expect(createGenerationServiceMock).toHaveBeenCalledWith({
      fetch: expect.any(Function),
    });
  });

  it("falls back to the owning human's AI config for agent processes", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/provider": "owner-provider",
      "users/1000/ai/model": "owner-model",
      "users/1000/ai/api_key": "owner-key",
      "users/1000/ai/reasoning": "high",
      "users/1000/ai/max_tokens": "1234",
      "users/1000/ai/context_window_tokens": "2222",
      "users/1000/ai/max_context_bytes": "4321",
      "users/1000/ai/generation/timeout_ms": "90000",
      "users/1000/ai/tools/approval": '{"default":"deny","rules":[]}',
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.owner).toMatchObject({
      uid: 1000,
      username: "sam",
      home: "/home/sam",
    });
    expect(result.provider).toBe("owner-provider");
    expect(result.model).toBe("owner-model");
    expect(result.apiKey).toBe("owner-key");
    expect(result.reasoning).toBe("high");
    expect(result.maxTokens).toBe(1234);
    expect(result.contextWindowTokens).toBe(2222);
    expect(result.contextWindowSource).toBe("config");
    expect(result.maxContextBytes).toBe(4321);
    expect(result.generationTimeoutMs).toBe(90000);
    expect(result.accountApprovalPolicy).toBe('{"default":"deny","rules":[]}');
  });

  it("resolves agent model profile references through the owning human", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "users/2000/ai/model_profile": "fast-stack",
      "users/2000/ai/provider": "stale-provider",
      "users/2000/ai/model": "stale-model",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "fast-stack",
          name: "Fast Stack",
          values: {
            "config/ai/provider": "custom",
            "config/ai/model": "zai-glm-4.7",
            "config/ai/base_url": "http://127.0.0.1:8080/v1",
            "config/ai/provider_style": "openai-chat-completions",
            "config/ai/transport_target": "linux-machine",
            "config/ai/api_key": "redacted",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/1000/ai/model_profiles/fast-stack/api_key": "profile-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("custom");
    expect(result.model).toBe("zai-glm-4.7");
    expect(result.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(result.providerStyle).toBe("openai-chat-completions");
    expect(result.transportTarget).toBe("linux-machine");
    expect(result.apiKey).toBe("profile-key");
  });

  it("resolves fallback model presets from account fallback config", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "users/2000/ai/model_profile": "fast-stack",
      "users/2000/ai/fallback_model_profile": "safe-stack",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [
          {
            id: "fast-stack",
            name: "Fast Stack",
            values: {
              "config/ai/provider": "custom",
              "config/ai/model": "zai-glm-4.7",
              "config/ai/base_url": "http://127.0.0.1:8080/v1",
              "config/ai/provider_style": "openai-chat-completions",
              "config/ai/api_key": "redacted",
            },
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: "safe-stack",
            name: "Safe Stack",
            values: {
              "config/ai/provider": "openrouter",
              "config/ai/model": "openai/gpt-5-mini",
              "config/ai/base_url": "https://openrouter.ai/api/v1",
              "config/ai/provider_style": "openai-chat-completions",
              "config/ai/api_key": "redacted",
              "config/ai/max_tokens": "4096",
            },
            createdAt: 1,
            updatedAt: 3,
          },
        ],
      }),
      "users/1000/ai/model_profiles/fast-stack/api_key": "profile-key",
      "users/1000/ai/model_profiles/safe-stack/api_key": "fallback-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("custom");
    expect(result.model).toBe("zai-glm-4.7");
    expect(result.fallbacks).toEqual([
      expect.objectContaining({
        profileId: "safe-stack",
        profileName: "Safe Stack",
        provider: "openrouter",
        model: "openai/gpt-5-mini",
        baseUrl: "https://openrouter.ai/api/v1",
        providerStyle: "openai-chat-completions",
        apiKey: "fallback-key",
        maxTokens: 4096,
      }),
    ]);
  });

  it("keeps fallback presets that only change credentials", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/provider": "openrouter",
      "users/1000/ai/model": "openai/gpt-5-mini",
      "users/1000/ai/base_url": "https://openrouter.ai/api/v1",
      "users/1000/ai/provider_style": "openai-chat-completions",
      "users/1000/ai/api_key": "primary-key",
      "users/1000/ai/fallback_model_profile": "secondary-credential",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "secondary-credential",
          name: "Secondary Credential",
          values: {
            "config/ai/provider": "openrouter",
            "config/ai/model": "openai/gpt-5-mini",
            "config/ai/base_url": "https://openrouter.ai/api/v1",
            "config/ai/provider_style": "openai-chat-completions",
            "config/ai/api_key": "redacted",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/1000/ai/model_profiles/secondary-credential/api_key": "secondary-key",
    }));

    expect(result.fallbacks).toEqual([
      expect.objectContaining({
        profileId: "secondary-credential",
        profileName: "Secondary Credential",
        provider: "openrouter",
        model: "openai/gpt-5-mini",
        baseUrl: "https://openrouter.ai/api/v1",
        providerStyle: "openai-chat-completions",
        apiKey: "secondary-key",
      }),
    ]);
  });

  it("resolves system fallback model presets from root profiles for non-root runs", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "config/ai/fallback_model_profile": "root-safe-stack",
      "users/0/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "root-safe-stack",
          name: "Root Safe Stack",
          values: {
            "config/ai/provider": "openrouter",
            "config/ai/model": "openai/gpt-5-mini",
            "config/ai/base_url": "https://openrouter.ai/api/v1",
            "config/ai/provider_style": "openai-chat-completions",
            "config/ai/api_key": "redacted",
            "config/ai/max_tokens": "4096",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/0/ai/model_profiles/root-safe-stack/api_key": "root-fallback-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.fallbacks).toEqual([
      expect.objectContaining({
        profileId: "root-safe-stack",
        profileName: "Root Safe Stack",
        provider: "openrouter",
        model: "openai/gpt-5-mini",
        baseUrl: "https://openrouter.ai/api/v1",
        providerStyle: "openai-chat-completions",
        apiKey: "root-fallback-key",
        maxTokens: 4096,
      }),
    ]);
  });

  it("resolves legacy raw agent model overrides through matching owner profiles", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "users/2000/ai/model": "zai-glm-4.7",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "fast-stack",
          name: "Fast Stack",
          values: {
            "config/ai/provider": "custom",
            "config/ai/model": "zai-glm-4.7",
            "config/ai/base_url": "http://127.0.0.1:8080/v1",
            "config/ai/provider_style": "openai-chat-completions",
            "config/ai/api_key": "redacted",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/1000/ai/model_profiles/fast-stack/api_key": "profile-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("custom");
    expect(result.model).toBe("zai-glm-4.7");
    expect(result.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(result.providerStyle).toBe("openai-chat-completions");
    expect(result.apiKey).toBe("profile-key");
  });

  it("does not infer a profile when raw agent provider fields are configured", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/provider": "workers-ai",
      "config/ai/model": "@cf/default/model",
      "users/2000/ai/provider": "custom",
      "users/2000/ai/model": "zai-glm-4.7",
      "users/2000/ai/base_url": "http://raw.example/v1",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "fast-stack",
          name: "Fast Stack",
          values: {
            "config/ai/provider": "profile-provider",
            "config/ai/model": "zai-glm-4.7",
            "config/ai/base_url": "http://profile.example/v1",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("custom");
    expect(result.model).toBe("zai-glm-4.7");
    expect(result.baseUrl).toBe("http://raw.example/v1");
  });

  it("prefers agent AI config over the owning human's config", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/provider": "owner-provider",
      "users/1000/ai/model": "owner-model",
      "users/1000/ai/api_key": "owner-key",
      "users/1000/ai/model_profile": "owner-stack",
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id: "owner-stack",
          name: "Owner Stack",
          values: {
            "config/ai/provider": "owner-profile-provider",
            "config/ai/model": "owner-profile-model",
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      }),
      "users/2000/ai/provider": "agent-provider",
      "users/2000/ai/model": "agent-model",
      "users/2000/ai/api_key": "agent-key",
      "users/1000/ai/tools/approval": '{"default":"deny","rules":[]}',
      "users/2000/ai/tools/approval": '{"default":"auto","rules":[]}',
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("agent-provider");
    expect(result.model).toBe("agent-model");
    expect(result.apiKey).toBe("agent-key");
    expect(result.accountApprovalPolicy).toBe('{"default":"auto","rules":[]}');
  });

  it("prefers process AI config overrides over account and system config", async () => {
    const result = await handleAiConfig({
      processOverrides: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-4.1-mini",
        "config/ai/api_key": "process-chat-key",
        "config/ai/reasoning": "low",
        "config/ai/max_tokens": "2048",
        "config/ai/context_window_tokens": "64000",
        "config/ai/max_context_bytes": "12000",
        "config/ai/generation/timeout_ms": "45000",
        "config/ai/image/read/provider": "openai",
        "config/ai/image/read/model": "gpt-4o-mini",
        "config/ai/image/read/api_key": "process-image-key",
        "config/ai/image/read/input_format": "chat",
        "config/ai/image/read/max_tokens": "777",
        "config/ai/image/generation/provider": "openai",
        "config/ai/image/generation/model": "gpt-image-1",
        "config/ai/transcription/provider": "openai",
        "config/ai/transcription/model": "gpt-4o-transcribe",
        "config/ai/speech/provider": "openai",
        "config/ai/speech/model": "gpt-4o-mini-tts",
        "config/ai/speech/speaker": "alloy",
      },
    }, makeAiConfigContext({
      "users/1000/ai/provider": "owner-provider",
      "users/1000/ai/model": "owner-model",
      "users/1000/ai/api_key": "owner-key",
      "config/ai/provider": "system-provider",
      "config/ai/model": "system-model",
      "config/ai/api_key": "system-key",
    }));

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(result.apiKey).toBe("process-chat-key");
    expect(result.reasoning).toBe("low");
    expect(result.maxTokens).toBe(2048);
    expect(result.contextWindowTokens).toBe(64000);
    expect(result.contextWindowSource).toBe("config");
    expect(result.maxContextBytes).toBe(12000);
    expect(result.generationTimeoutMs).toBe(45000);
    expect(result.media).toMatchObject({
      imageReadingProvider: "openai",
      imageReadingModel: "gpt-4o-mini",
      imageReadingApiKey: "process-image-key",
      imageReadingInputFormat: "chat",
      imageReadingMaxTokens: 777,
      imageGenerationProvider: "openai",
      imageGenerationModel: "gpt-image-1",
      imageGenerationApiKey: "process-chat-key",
      transcriptionProvider: "openai",
      transcriptionModel: "gpt-4o-transcribe",
      transcriptionApiKey: "process-chat-key",
      speechProvider: "openai",
      speechModel: "gpt-4o-mini-tts",
      speechApiKey: "process-chat-key",
      speechSpeaker: "alloy",
    });
  });

  it("falls through invalid normalized process config values", async () => {
    const result = await handleAiConfig({
      processOverrides: {
        "config/ai/generation/timeout_ms": "invalid",
        "config/ai/image/read/provider": " ",
        "config/ai/image/read/input_format": "invalid",
        "config/ai/image/read/max_tokens": "invalid",
      },
    }, makeAiConfigContext({
      "users/1000/ai/generation/timeout_ms": "90000",
      "users/1000/ai/image/read/provider": "openai",
      "users/1000/ai/image/read/input_format": "chat",
      "users/1000/ai/image/read/max_tokens": "321",
    }));

    expect(result.generationTimeoutMs).toBe(90000);
    expect(result.media).toMatchObject({
      imageReadingProvider: "openai",
      imageReadingInputFormat: "chat",
      imageReadingMaxTokens: 321,
    });
  });

  it("hydrates process profile secrets inside internal AI config resolution", async () => {
    const result = await handleAiConfig({
      processOverrides: {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-4.1-mini",
        "config/ai/image/read/provider": "openai",
        "config/ai/image/read/model": "gpt-4o-mini",
      },
      processProfile: {
        id: "fast-stack",
        name: "Fast Stack",
        appliedAt: 1,
      },
    }, makeAiConfigContext({
      "users/1000/ai/api_key": "owner-key",
      "users/1000/ai/model_profiles/fast-stack/api_key": "sk-profile-chat",
      "users/1000/ai/model_profiles/fast-stack/image/read/api_key": "sk-profile-image",
      "config/ai/api_key": "system-key",
    }));

    expect(result.apiKey).toBe("sk-profile-chat");
    expect(result.media?.imageReadingApiKey).toBe("sk-profile-image");
  });

  it("resolves the media model stack with owner fallback", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/transcription/model": "@cf/openai/whisper-tiny-en",
      "users/1000/ai/transcription/api_key": "owner-transcription-key",
      "users/1000/ai/api_key": "owner-chat-key",
      "users/1000/ai/image/read/model": "@cf/owner/vision",
      "users/1000/ai/image/read/api_key": "owner-reader-key",
      "users/1000/ai/image/read/input_format": "chat",
      "users/1000/ai/image/read/max_bytes": "12345",
      "users/1000/ai/image/read/max_tokens": "321",
      "users/1000/ai/image/read/timeout_ms": "9876",
      "users/1000/ai/image/read/prompt": "Read the screenshot.",
      "users/1000/ai/image/generation/provider": "openai",
      "users/1000/ai/image/generation/model": "@cf/owner/image",
      "users/1000/ai/image/generation/api_key": "owner-image-key",
      "users/1000/ai/speech/provider": "openai",
      "users/1000/ai/speech/model": "@cf/owner/speech",
      "users/1000/ai/speech/api_key": "owner-speech-key",
      "users/2000/ai/image/read/model": "@cf/agent/vision",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.media).toMatchObject({
      transcriptionProvider: "workers-ai",
      transcriptionModel: "@cf/openai/whisper-tiny-en",
      transcriptionApiKey: "owner-transcription-key",
      imageReadingProvider: "workers-ai",
      imageReadingModel: "@cf/agent/vision",
      imageReadingApiKey: "owner-reader-key",
      imageReadingInputFormat: "chat",
      imageReadingMaxBytes: 12345,
      imageReadingMaxTokens: 321,
      imageReadingTimeoutMs: 9876,
      imageReadingPrompt: "Read the screenshot.",
      imageGenerationProvider: "openai",
      imageGenerationModel: "@cf/owner/image",
      imageGenerationApiKey: "owner-image-key",
      speechProvider: "openai",
      speechModel: "@cf/owner/speech",
      speechApiKey: "owner-speech-key",
    });
  });

  it("falls back the image reader API key to the resolved chat API key", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/api_key": "owner-chat-key",
      "users/1000/ai/image/read/provider": "openai",
      "users/1000/ai/image/read/model": "gpt-4o",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.apiKey).toBe("owner-chat-key");
    expect(result.media?.imageReadingApiKey).toBe("owner-chat-key");
  });

  it("includes default media stack values", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext());

    expect(result.media?.imageReadingProvider).toBe("workers-ai");
    expect(result.media?.imageReadingModel).toBe(DEFAULT_IMAGE_READING_MODEL);
    expect(result.media?.imageReadingApiKey).toBe("");
    expect(result.media?.imageReadingInputFormat).toBe(DEFAULT_IMAGE_READING_INPUT_FORMAT);
    expect(result.media?.imageReadingPrompt).toBe(DEFAULT_IMAGE_READING_PROMPT);
    expect(result.media?.speechProvider).toBe("workers-ai");
    expect(result.media?.speechModel).toBe(DEFAULT_AUDIO_SPEECH_MODEL);
    expect(result.media?.speechApiKey).toBe("");
    expect(result.media?.transcriptionProvider).toBe("workers-ai");
    expect(result.media?.transcriptionModel).toBe(DEFAULT_AUDIO_TRANSCRIPTION_MODEL);
    expect(result.media?.transcriptionApiKey).toBe("");
  });

  it("uses provider-specific media defaults when only the provider changes", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/api_key": "system-chat-key",
      "config/ai/transcription/provider": "openai",
      "config/ai/speech/provider": "openai",
      "config/ai/image/read/provider": "openai",
      "config/ai/image/generation/provider": "openai",
    }));

    expect(result.media).toMatchObject({
      transcriptionProvider: "openai",
      transcriptionModel: "gpt-4o-transcribe",
      transcriptionApiKey: "system-chat-key",
      imageReadingProvider: "openai",
      imageReadingModel: "gpt-4o",
      imageReadingApiKey: "system-chat-key",
      imageGenerationProvider: "openai",
      imageGenerationModel: "gpt-image-1.5",
      imageGenerationApiKey: "system-chat-key",
      speechProvider: "openai",
      speechModel: "gpt-4o-mini-tts",
      speechApiKey: "system-chat-key",
      speechSpeaker: "alloy",
    });
  });
});

describe("handleAiTranscriptionCreate", () => {
  function makeTranscriptionContext(options: {
    config?: Record<string, string>;
    response?: unknown;
  } = {}): KernelContext {
    const config = options.config ?? {};
    return {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
        getExplicit: vi.fn((key: string) => config[key] ?? null),
      },
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({
            text: "turn on the office lights",
            transcription_info: { duration: 1.25, language: "en" },
          })),
        },
      },
    } as unknown as KernelContext;
  }

  function transcriptionFallbackConfig(
    id: string,
    values: Record<string, string>,
  ): Record<string, string> {
    return {
      "users/1000/ai/fallback_model_profile": id,
      "users/1000/ai/model_profiles": JSON.stringify({
        profiles: [{
          id,
          name: id,
          values,
          createdAt: 1,
          updatedAt: 1,
        }],
      }),
    };
  }

  it("transcribes audio through the shared Workers AI path", async () => {
    const ctx = makeTranscriptionContext();

    const result = await handleAiTranscriptionCreate({
      audio: {
        mimeType: "audio/webm",
      },
      prompt: "short command",
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.text).toBe("turn on the office lights");
    expect(result.duration).toBe(1.25);
    expect(result.language).toBe("en");
    expect(result.model).toBe(DEFAULT_AUDIO_TRANSCRIPTION_MODEL);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      expect.objectContaining({
        audio: "AQID",
        task: "transcribe",
        initial_prompt: "short command",
        vad_filter: true,
        condition_on_previous_text: false,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("honors process-local transcription media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeTranscriptionContext(), {
      "config/ai/transcription/model": "@cf/openai/whisper-large-v3-turbo",
      "config/ai/transcription/max_bytes": "8",
    });

    const result = await handleAiTranscriptionCreate({
      audio: {
        mimeType: "audio/ogg",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc:test",
      expect.objectContaining({
        call: "proc.ai.config.get",
        args: { redacted: false },
      }),
    );
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/openai/whisper-large-v3-turbo",
      expect.any(Object),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("uses the requested same-owner process AI configuration", async () => {
    const ctx = makeTranscriptionContext({
      config: {
        "users/2000/ai/transcription/model": "@cf/agent/transcriber",
        "users/1000/ai/transcription/model": "@cf/owner/transcriber",
      },
    });
    (ctx as { procs: unknown }).procs = {
      get: vi.fn(() => ({
        processId: "proc:agent",
        uid: 2000,
        ownerUid: 1000,
        gid: 2000,
        gids: [2000],
        username: "friday",
        home: "/home/friday",
        cwd: "/home/friday",
      })),
      getOwnerUid: vi.fn(() => 1000),
    };
    (ctx as { auth: unknown }).auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "sam",
        home: "/home/sam",
      })),
      resolveGids: vi.fn(() => [1000]),
    };
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "proc-ai-config",
      ok: true,
      data: {
        ok: true,
        pid: "proc:agent",
        config: {
          version: 1,
          values: {
            "config/ai/transcription/model": "@cf/process/transcriber",
          },
          updatedAt: 1,
        },
      },
    });

    const result = await handleAiTranscriptionCreate({
      pid: "proc:agent",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/process/transcriber");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc:agent",
      expect.objectContaining({ call: "proc.ai.config.get" }),
    );
  });

  it("rejects cross-owner process configuration access", async () => {
    const ctx = makeTranscriptionContext();
    (ctx as { procs: unknown }).procs = {
      get: vi.fn(() => ({ ownerUid: 2000 })),
      getOwnerUid: vi.fn(() => 1000),
    };

    await expect(handleAiTranscriptionCreate({
      pid: "proc:other",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow(
      "Permission denied: cannot access process proc:other",
    );
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

  it("allows root to use another owner's process configuration", async () => {
    const ctx = makeTranscriptionContext();
    ctx.identity!.process.uid = 0;
    (ctx as { procs: unknown }).procs = {
      get: vi.fn(() => ({
        processId: "proc:other",
        uid: 2000,
        ownerUid: 1000,
        gid: 2000,
        gids: [2000],
        username: "friday",
        home: "/home/friday",
        cwd: "/home/friday",
      })),
      getOwnerUid: vi.fn((pid: string) => pid === "proc:other" ? 1000 : 0),
    };
    (ctx as { auth: unknown }).auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "sam",
        home: "/home/sam",
      })),
      resolveGids: vi.fn(() => [1000]),
    };
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "proc-ai-config",
      ok: true,
      data: {
        ok: true,
        pid: "proc:other",
        config: {
          version: 1,
          values: { "config/ai/transcription/model": "@cf/root-selected/transcriber" },
          updatedAt: 1,
        },
      },
    });

    const result = await handleAiTranscriptionCreate({
      pid: "proc:other",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/root-selected/transcriber");
  });

  it("falls back through an explicitly configured transcription stack", async () => {
    const primaryModel = "@cf/openai/whisper-large-v3-turbo";
    const fallbackModel = "@cf/openai/whisper-tiny-en";
    const ctx = makeTranscriptionContext({
      config: {
        "config/ai/transcription/model": primaryModel,
        ...transcriptionFallbackConfig("safe-stack", {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-5-mini",
          "config/ai/transcription/provider": "workers-ai",
          "config/ai/transcription/model": fallbackModel,
        }),
      },
    });
    vi.mocked(ctx.env.AI.run)
      .mockResolvedValueOnce({ text: "" })
      .mockResolvedValueOnce({ text: "fallback transcript" });

    const result = await handleAiTranscriptionCreate({
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result).toMatchObject({
      text: "fallback transcript",
      provider: "workers-ai",
      model: fallbackModel,
    });
    expect(vi.mocked(ctx.env.AI.run).mock.calls.map(([model]) => model)).toEqual([
      primaryModel,
      fallbackModel,
    ]);
  });

  it("falls back after the primary transcription provider fails", async () => {
    const fallbackModel = "@cf/openai/whisper-tiny-en";
    const ctx = makeTranscriptionContext({
      config: transcriptionFallbackConfig("safe-stack", {
        "config/ai/transcription/provider": "workers-ai",
        "config/ai/transcription/model": fallbackModel,
      }),
    });
    vi.mocked(ctx.env.AI.run)
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({ text: "fallback transcript" });

    const result = await handleAiTranscriptionCreate({
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe(fallbackModel);
    expect(ctx.env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("deduplicates an identical transcription fallback stack", async () => {
    const model = "@cf/openai/whisper-large-v3-turbo";
    const ctx = makeTranscriptionContext({
      config: {
        "config/ai/transcription/model": model,
        ...transcriptionFallbackConfig("same-stack", {
          "config/ai/transcription/provider": "workers-ai",
          "config/ai/transcription/model": model,
        }),
      },
      response: { text: "" },
    });

    await expect(handleAiTranscriptionCreate({
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow("Transcription unavailable");
    expect(ctx.env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("does not treat a fallback text model as a transcription model", async () => {
    const ctx = makeTranscriptionContext({
      config: transcriptionFallbackConfig("text-only", {
        "config/ai/provider": "openai",
        "config/ai/model": "gpt-5-mini",
      }),
      response: { text: "" },
    });

    await expect(handleAiTranscriptionCreate({
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow("Transcription unavailable");
    expect(ctx.env.AI.run).toHaveBeenCalledTimes(1);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("does not start a fallback after caller cancellation", async () => {
    const controller = new AbortController();
    const ctx = makeTranscriptionContext({
      config: transcriptionFallbackConfig("safe-stack", {
        "config/ai/transcription/provider": "workers-ai",
        "config/ai/transcription/model": "@cf/openai/whisper-tiny-en",
      }),
    });
    (ctx as { requestSignal?: AbortSignal }).requestSignal = controller.signal;
    vi.mocked(ctx.env.AI.run).mockImplementation((_model, _input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      })
    );

    const request = handleAiTranscriptionCreate({
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));
    await vi.waitFor(() => expect(ctx.env.AI.run).toHaveBeenCalledTimes(1));
    controller.abort(new Error("user changed conversation"));

    await expect(request).rejects.toThrow("user changed conversation");
    expect(ctx.env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("uses configured transcription model and byte limits", async () => {
    const ctx = makeTranscriptionContext({
      config: {
        "config/ai/transcription/model": "@cf/openai/whisper-tiny-en",
        "config/ai/transcription/max_bytes": "2",
      },
    });

    await expect(handleAiTranscriptionCreate({
      audio: {
        mimeType: "audio/ogg",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow("exceeds limit");
  });

  it("rejects non-audio payloads", async () => {
    const ctx = makeTranscriptionContext();

    await expect(handleAiTranscriptionCreate({
      audio: {
        mimeType: "text/plain",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow("audio MIME type");

    await expect(handleAiTranscriptionCreate({
      audio: {
        mimeType: "audio/ogg",
        ...({ data: "AQID" } as object),
      },
    }, ctx)).rejects.toThrow("audio request body is required");
  });
});

describe("handleAiImageRead", () => {
  function makeImageReadContext(options: {
    config?: Record<string, string>;
    response?: unknown;
  } = {}): KernelContext {
    const config = options.config ?? {};
    return {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
        getExplicit: vi.fn((key: string) => config[key] ?? null),
      },
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({
            choices: [{
              message: {
                content: "A small terminal window with green text.",
              },
            }],
          })),
        },
      },
    } as unknown as KernelContext;
  }

  it("reads images through the configured Workers AI vision path", async () => {
    const ctx = makeImageReadContext();

    const result = await handleAiImageRead({
      image: {
        mimeType: "image/png",
      },
      prompt: "read this screenshot",
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.text).toBe("A small terminal window with green text.");
    expect(result.model).toBe(DEFAULT_IMAGE_READING_MODEL);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_READING_MODEL,
      {
        max_completion_tokens: DEFAULT_IMAGE_READING_MAX_TOKENS,
        messages: expect.any(Array),
      },
    );
  });

  it("honors process-local image reading media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeImageReadContext(), {
      "config/ai/image/read/model": "@cf/llava-hf/llava-1.5-7b-hf",
      "config/ai/image/read/max_tokens": "77",
    });

    const result = await handleAiImageRead({
      image: {
        mimeType: "image/png",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/llava-hf/llava-1.5-7b-hf");
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/llava-hf/llava-1.5-7b-hf",
      expect.objectContaining({
        max_tokens: 77,
      }),
    );
  });

  it("uses image read byte limits and rejects non-image payloads", async () => {
    const ctx = makeImageReadContext({
      config: {
        "config/ai/image/read/max_bytes": "2",
      },
    });

    await expect(handleAiImageRead({
      image: {
        mimeType: "image/png",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow("exceeds limit");

    await expect(handleAiImageRead({
      image: {
        mimeType: "text/plain",
      },
    }, makeImageReadContext(), bodyFromBytes(new Uint8Array([1])))).rejects.toThrow("image MIME type");

    await expect(handleAiImageRead({
      image: {
        mimeType: "image/svg+xml",
      },
    }, makeImageReadContext(), bodyFromBytes(new Uint8Array([1])))).rejects.toThrow(
      "SVG image reading requires rasterization",
    );
  });

  it("cancels image body reads with the request", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    let cancelled: unknown;
    const ctx = makeImageReadContext();
    ctx.requestSignal = controller.signal;
    controller.abort(reason);

    const read = handleAiImageRead({
      image: { mimeType: "image/png" },
    }, ctx, {
      length: 1,
      stream: new ReadableStream({
        cancel(value) {
          cancelled = value;
        },
      }),
    });

    await expect(read).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
  });
});

describe("handleAiImageGenerate", () => {
  function makeImageGenerateContext(options: {
    config?: Record<string, string>;
    response?: unknown;
  } = {}): KernelContext {
    const config = options.config ?? {};
    return {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
        getExplicit: vi.fn((key: string) => config[key] ?? null),
      },
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({ image: "AQID" })),
        },
      },
    } as unknown as KernelContext;
  }

  it("generates images through the configured Workers AI path", async () => {
    const ctx = makeImageGenerateContext();

    const result = await handleAiImageGenerate({ prompt: "a green terminal" }, ctx);

    expect(result.data.image).toEqual({
      mimeType: "image/jpeg",
      size: 3,
    });
    expect(result.body && [...await bodyToBytes(result.body)]).toEqual([1, 2, 3]);
    expect(result.data.model).toBe(DEFAULT_IMAGE_GENERATION_MODEL);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_GENERATION_MODEL,
      { prompt: "a green terminal" },
    );
  });

  it("honors process-local image generation media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeImageGenerateContext(), {
      "config/ai/image/generation/model": "@cf/black-forest-labs/flux-1-schnell",
    });

    const result = await handleAiImageGenerate({ prompt: "a blue terminal" }, ctx);

    expect(result.data.model).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/black-forest-labs/flux-1-schnell",
      { prompt: "a blue terminal" },
    );
  });

  it("hydrates process profile secrets for media syscalls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const ctx = attachProcessAiSnapshot(makeImageGenerateContext({
      config: {
        "users/1000/ai/model_profiles/fast-stack/image/generation/api_key": "sk-profile-image",
      },
    }), {
      "config/ai/image/generation/provider": "openai",
      "config/ai/image/generation/model": "gpt-image-1",
    }, "proc:test", {
      id: "fast-stack",
      name: "Fast Stack",
      appliedAt: 1,
    });

    try {
      const result = await handleAiImageGenerate({ prompt: "a profile terminal" }, ctx);

      expect(result.data.provider).toBe("openai");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/images/generations"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-profile-image",
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to configured media defaults when the process AI snapshot is unavailable", async () => {
    const ctx = makeImageGenerateContext({
      config: {
        "config/ai/image/generation/model": "@cf/example/fallback-image",
      },
    });
    (ctx as { processId?: string }).processId = "proc:missing";
    (ctx as { procs?: Partial<KernelContext["procs"]> }).procs = {
      getOwnerUid: vi.fn(() => 1000),
    };
    sendFrameToProcessMock.mockRejectedValueOnce(new Error("process unavailable"));

    const result = await handleAiImageGenerate({ prompt: "a fallback terminal" }, ctx);

    expect(result.data.model).toBe("@cf/example/fallback-image");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "proc:missing",
      expect.objectContaining({
        call: "proc.ai.config.get",
      }),
    );
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/example/fallback-image",
      { prompt: "a fallback terminal" },
    );
  });

  it("requires a prompt", async () => {
    await expect(handleAiImageGenerate({ prompt: "" }, makeImageGenerateContext())).rejects.toThrow("prompt is required");
  });
});

describe("handleAiSpeechCreate", () => {
  function makeSpeechContext(options: {
    config?: Record<string, string>;
    response?: unknown;
  } = {}): KernelContext {
    const config = options.config ?? {};
    return {
      identity: {
        role: "user",
        process: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        },
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
        getExplicit: vi.fn((key: string) => config[key] ?? null),
      },
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          })),
        },
      },
    } as unknown as KernelContext;
  }

  it("synthesizes speech through Workers AI and returns browser-playable audio", async () => {
    const ctx = makeSpeechContext();

    const result = await handleAiSpeechCreate({ text: "Hello GSV" }, ctx);

    expect(result.data.audio).toEqual({
      mimeType: "audio/mpeg",
      size: 3,
    });
    expect(result.body && [...await bodyToBytes(result.body)]).toEqual([1, 2, 3]);
    expect(result.data.provider).toBe("workers-ai");
    expect(result.data.model).toBe(DEFAULT_AUDIO_SPEECH_MODEL);
    expect(result.data.voice).toBe(DEFAULT_AUDIO_SPEECH_SPEAKER);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_SPEECH_MODEL,
      expect.objectContaining({
        text: "Hello GSV",
        speaker: DEFAULT_AUDIO_SPEECH_SPEAKER,
        encoding: "mp3",
      }),
    );
  });

  it("honors process-local speech media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeSpeechContext(), {
      "config/ai/speech/model": "@cf/deepgram/aura-1",
      "config/ai/speech/speaker": "orpheus",
      "config/ai/speech/encoding": "wav",
    });

    const result = await handleAiSpeechCreate({ text: "Hello GSV" }, ctx);

    expect(result.data.model).toBe("@cf/deepgram/aura-1");
    expect(result.data.voice).toBe("orpheus");
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-1",
      expect.objectContaining({
        speaker: "orpheus",
        encoding: "wav",
      }),
    );
  });

  it("normalizes markdown before sending text to the speech model", async () => {
    const ctx = makeSpeechContext();

    await handleAiSpeechCreate({
      text: [
        "**Result:**",
        "Ready ✅",
        "",
        "- [Docs](https://example.com/docs)",
        "- Launch 🚀 soon",
        "",
        "| Name | State |",
        "| --- | --- |",
        "| GSV | **ready** |",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    }, ctx);

    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_SPEECH_MODEL,
      expect.objectContaining({
        text: [
          "Result:",
          "Ready",
          "",
          "Docs",
          "Launch soon",
          "",
          "Table. Row 1: Name: GSV; State: ready.",
          "",
          "Code block omitted.",
        ].join("\n"),
      }),
    );
  });

  it("allows callers to opt out of markdown speech normalization", async () => {
    const ctx = makeSpeechContext();

    await handleAiSpeechCreate({ text: "**literal**", textFormat: "plain" }, ctx);

    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_AUDIO_SPEECH_MODEL,
      expect.objectContaining({
        text: "**literal**",
      }),
    );
  });

  it("skips markdown-only speech chunks that normalize to empty text", async () => {
    const ctx = makeSpeechContext();

    const result = await handleAiSpeechCreate({ text: "```." }, ctx);

    expect(result).toEqual({
      data: {
        audio: {
          mimeType: "",
          size: 0,
        },
        provider: "none",
        model: "none",
        skipped: true,
      },
    });
    expect(ctx.env.AI.run).not.toHaveBeenCalled();
  });

  it("uses configured speech defaults and character limits", async () => {
    const ctx = makeSpeechContext({
      config: {
        "config/ai/speech/model": "@cf/deepgram/aura-2-en",
        "config/ai/speech/speaker": "asteria",
        "config/ai/speech/encoding": "mp3",
        "config/ai/speech/max_chars": "4",
      },
      response: { audio: "AQID", mime_type: "audio/mpeg" },
    });

    const result = await handleAiSpeechCreate({ text: "test" }, ctx);

    expect(result.data.voice).toBe("asteria");
    expect(result.body && [...await bodyToBytes(result.body)]).toEqual([1, 2, 3]);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-2-en",
      expect.objectContaining({
        text: "test",
        speaker: "asteria",
        encoding: "mp3",
      }),
    );
    await expect(handleAiSpeechCreate({ text: "too long" }, ctx)).rejects.toThrow("speech limit");
  });

  it("maps MeloTTS requests to the model-specific input shape", async () => {
    const ctx = makeSpeechContext({
      response: { audio: "AQID" },
    });

    await handleAiSpeechCreate({
      text: "hola",
      model: "@cf/myshell-ai/melotts",
      language: "es",
    }, ctx);

    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/myshell-ai/melotts",
      {
        prompt: "hola",
        lang: "es",
      },
    );
  });
});
