type KernelTestValue<T = string | number | boolean | null | undefined> = T;

import { beforeEach, describe, expect, it, vi } from "vitest";
import { principalOf } from "./context";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import type { TargetRecord } from "./target-registry";
import type { OAuthAccountRecord } from "./oauth-store";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";

const generateMock = vi.fn();
const createGenerationServiceMock = vi.fn((_options?: KernelTestValue) => ({
  generate: generateMock,
  stream: vi.fn(),
  generateText: vi.fn(),
}));
const seedBuiltinSkillsToHomeMock = vi.fn();
import * as inferenceService from "../inference/service";
import * as skillsSeed from "./sys/skills-seed";
vi.spyOn(inferenceService, "createGenerationService").mockImplementation(createGenerationServiceMock);
vi.spyOn(skillsSeed, "seedBuiltinSkillsToHome").mockImplementation(seedBuiltinSkillsToHomeMock);

import {
  handleAiContext,
  handleAiConfig,
  handleAiModels,
  handleAiImageGenerate,
  handleAiImageRead,
  handleAiSpeechCreate,
  handleAiTextGenerate,
  handleAiTools,
  handleAiTranscriptionCreate,
} from "./ai";
import { DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "../inference/transcription";
import {
  DEFAULT_IMAGE_READING_MAX_OBJECTS,
  DEFAULT_IMAGE_READING_MAX_TOKENS,
  DEFAULT_IMAGE_READING_MODEL,
} from "../inference/image-reading";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "../inference/capabilities";
import { inferenceLogicalRequestId } from "../inference/provider";
import { MAIL_SEND, syscallToolName } from "../syscalls/constants";
import { SYSTEM_CONFIG_DEFAULTS } from "./config";

// SAFETY: test fixture is constructed with the asserted kernel domain shape.
const TEST_INSTALLATION_ID = "singleton" as KernelContext["installationId"];

beforeEach(() => {
  generateMock.mockReset();
  createGenerationServiceMock.mockClear();
  seedBuiltinSkillsToHomeMock.mockReset();
  seedBuiltinSkillsToHomeMock.mockResolvedValue({ username: "sam", copied: 0, skipped: 0 });
});

function makeDevice(partial: Partial<TargetRecord> & { target_id: string }): TargetRecord {
  const now = 1_800_000_000_000;
  return {
    target_id: partial.target_id,
    owner_uid: partial.owner_uid ?? 1000,
    label: partial.label ?? partial.target_id,
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

function makeTestConfig(config: Record<string, string> = {}) {
  return {
    get: vi.fn((key: string) => config[key] ?? SYSTEM_CONFIG_DEFAULTS[key] ?? null),
    getExplicit: vi.fn((key: string) => config[key] ?? null),
    list: vi.fn((prefix: string) => Object.entries(config)
      .filter(([key]) => key.startsWith(`${prefix.replace(/\/$/, "")}/`))
      .map(([key, value]) => ({ key, value }))),
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
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    installationId: TEST_INSTALLATION_ID,
    peer: testPeer({ kind: "human", account: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 2000 ? "friday" : "sam",
        home: uid === 2000 ? "/home/friday" : "/home/sam",
        cwd: uid === 2000 ? "/home/friday" : "/home/sam",
      }, calls: options.capabilities ?? ["*"] }),
    processId: options.processId,
    procs: {
      getOwnerUid: vi.fn((processId: string) =>
        processId === options.processId ? ownerUid : null
      ),
    },
    targets: {
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
    env: {
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      LOADER: {} as WorkerLoader,
    },
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
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
    expect(syscallToolName(MAIL_SEND)).toBeUndefined();
    expect(syscallToolName("mail.status")).toBeUndefined();
    expect(
      result.tools.every((tool) =>
        !tool.name.startsWith("MCP_") &&
        !tool.name.includes("Spawn") &&
        !tool.name.includes("Schedule") &&
        tool.name !== "Copy"
      ),
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
      "ai.tools should stay a fixed Linux-like surface: filesystem tools, Shell, and CodeMode only. Do not expose OS conveniences such as spawn, sched, MCP, or copy as direct LLM tools.",
    ).toBe(true);
    expect(result.mcpServers).toEqual(["Search"]);
    const codeModeTool = result.tools.find((tool) => tool.name === "CodeMode");
    expect(codeModeTool?.description).toContain("mail.send");
    expect(codeModeTool?.description).toContain("return mcpTools.map");
    expect(codeModeTool?.description).toContain("inputSchema/outputSchema");
    expect(codeModeTool?.description).not.toContain("declare function lookup");
    expect(ctx.mcp.listTools).not.toHaveBeenCalled();
  });

  it("does not advertise CodeMode without a Worker Loader binding", async () => {
    const ctx = makeContext("ready");
    delete ctx.env.LOADER;

    const result = await handleAiTools(ctx);

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Delete",
      "Search",
      "Shell",
    ]);
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

  it("keeps routable tool schemas stable as online targets change", async () => {
    const records = Array.from({ length: 12 }, (_value, index) =>
      makeDevice({ target_id: `node-${String(index + 1).padStart(2, "0")}` })
    );
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeContext("ready"),
      targets: {
        listForUser: vi.fn(() => records),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleAiTools(ctx);
    const shell = result.tools.find((tool) => tool.name === "Shell");
    const description = JSON.stringify(shell?.inputSchema);

    expect(description).toContain("targets list");
    expect(description).toContain("online status");
    expect(description).toContain("accessible targets");
    expect(description).not.toContain("node-01");
    expect(description).not.toContain("node-11");
    expect(description).not.toContain("node-12");
    expect(result.targets).toHaveLength(12);

    // SAFETY: fixture replaces only the typed device-store method used by handleAiTools.
    const withoutTargets = await handleAiTools({
      ...ctx,
      targets: {
        listForUser: vi.fn(() => []),
      },
    } as KernelContext);
    expect(withoutTargets.tools.find((tool) => tool.name === "Shell")?.inputSchema)
      .toEqual(shell?.inputSchema);
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
      ripgit?: Fetcher;
      managedInference?: boolean;
    } = {},
  ): KernelContext {
    const uid = options.uid ?? 1000;
    const ownerUid = options.ownerUid ?? uid;
    const oauthAccounts = options.oauthAccounts ?? [];
    const env: Partial<KernelContext["env"]> = {};
    if (options.ripgit) env.RIPGIT = options.ripgit;
    if (options.managedInference) {
      // SAFETY: the base stack only checks that the managed inference binding exists.
      env.MANAGED_INFERENCE = {} as never;
    }
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId: TEST_INSTALLATION_ID,
      peer: testPeer({ kind: "human", account: {
          uid,
          gid: uid,
          gids: [uid],
          username: uid === 2000 ? "friday" : "sam",
          home: uid === 2000 ? "/home/friday" : "/home/sam",
          cwd: uid === 2000 ? "/home/friday" : "/home/sam",
        }, calls: options.capabilities ?? ["*"] }),
      config: makeTestConfig(config),
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
      targets: {
        listForUser: vi.fn(() => []),
      },
      adapters: {
        identityLinks: { list: vi.fn(() => []) },
      },
      mcpServers: {
        list: vi.fn(() => []),
      },
      mcp: {
        mcpConnections: {},
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
      env,
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
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

  function fakeJwtToken(payload: Record<string, KernelTestValue>): string {
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

  it("returns prompt-relevant context without model credentials", async () => {
    const ctx = makeAiConfigContext({
      "config/server/timezone": "Europe/Amsterdam",
      "config/ai/context.d/00-runtime.md": "Date: {{current.date}}",
    });
    // SAFETY: fixture implements the device-store method exercised by handleAiContext.
    ctx.targets = {
      listForUser: vi.fn(() => [makeDevice({ target_id: "desktop" })]),
    } as KernelContext["targets"];
    // SAFETY: fixture implements the MCP store method exercised by handleAiContext.
    ctx.mcpServers = {
      list: vi.fn(() => [{
        serverId: "server-1",
        uid: 1000,
        name: "Search",
        createdAt: 1,
        updatedAt: 2,
      }]),
    } as KernelContext["mcpServers"];
    // SAFETY: fixture provides the ready-connection projection read by handleAiContext.
    ctx.mcp = {
      mcpConnections: {
        "server-1": { connectionState: "ready" },
      },
    } as KernelContext["mcp"];

    const result = await handleAiContext({}, ctx);

    expect(result).toMatchObject({
      targets: [expect.objectContaining({ id: "desktop" })],
      mcpServers: ["Search"],
      system: { timezone: "Europe/Amsterdam" },
      systemContextFiles: [{ name: "00-runtime.md", text: "Date: {{current.date}}" }],
      skillIndexMode: "summary",
    });
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("model");
  });

  it("keeps context refresh usable when the skill catalog cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // SAFETY: fixture implements the single service-binding method used by RipgitClient.
    const ripgit = {
      fetch: vi.fn(async () => {
        throw new Error("ripgit temporarily unavailable");
      }),
    } as Fetcher;

    try {
      const result = await handleAiContext({}, makeAiConfigContext({}, { ripgit }));

      expect(result).toMatchObject({
        targets: [],
        mcpServers: [],
        skillIndexMode: "summary",
      });
      expect(result).not.toHaveProperty("skillIndex");
      expect(seedBuiltinSkillsToHomeMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to refresh skills.d index"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("skips built-in reconciliation and catalog reads when skill indexing is off", async () => {
    // SAFETY: fixture implements the single service-binding method used by RipgitClient.
    const ripgit = {
      fetch: vi.fn(async () => new Response("missing", { status: 404 })),
    } as Fetcher;

    const result = await handleAiContext({}, makeAiConfigContext({
      "config/ai/skills/index_mode": "off",
    }, { ripgit }));

    expect(result).toMatchObject({
      skillIndexMode: "off",
      skillIndex: [],
    });
    expect(seedBuiltinSkillsToHomeMock).not.toHaveBeenCalled();
    expect(ripgit.fetch).not.toHaveBeenCalled();
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

  it("reconciles the owning user's built-in skills before collecting the prompt index", async () => {
    let seedingComplete = false;
    seedBuiltinSkillsToHomeMock.mockImplementation(async () => {
      seedingComplete = true;
      return { username: "sam", copied: 3, skipped: 3 };
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ripgit = {
      fetch: vi.fn(async () => {
        expect(seedingComplete).toBe(true);
        return new Response("missing", { status: 404 });
      }),
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as Fetcher;
    const ctx = makeAiConfigContext({}, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
      ripgit,
    });

    await handleAiConfig({}, ctx);

    expect(seedBuiltinSkillsToHomeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ uid: 1000, username: "sam", home: "/home/sam" }),
    );
    expect(ripgit.fetch).toHaveBeenCalled();
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
    delete ctx.peer;

    const result = await handleAiConfig({}, ctx);

    expect(result.capabilities).toEqual([]);
  });

  it("uses a stored OpenAI Codex OAuth account when the provider key is blank", async () => {
    const ctx = makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
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
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
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
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
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
      // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
      "config/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
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
      "config/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
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

  it("generates text with a selected model entry and explicit generation options", async () => {
    const requestSignal = new AbortController().signal;
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-test",
        apiKey: "entry-secret",
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
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{
          id: "entry-1",
          name: "Fast",
          provider: "anthropic",
          model: "claude-test",
        }],
      }),
      "users/1000/ai/models/entry-1/api_key": "entry-secret",
    });

    const result = await handleAiTextGenerate({
      systemPrompt: "Be direct.",
      messages: [{ role: "user", content: "ping" }],
      config: { modelId: "entry-1" },
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
    expect(createGenerationServiceMock).toHaveBeenCalledWith({});
  });

  it("generates text with a stable Process model preference in the kernel", async () => {
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
        modelId: "fast-stack",
      },
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{
          id: "fast-stack",
          name: "Fast Stack",
          provider: "anthropic",
          model: "claude-process",
        }],
      }),
      "users/1000/ai/models/fast-stack/api_key": "profile-secret",
    }, {
      processId: "task-1",
    }));

    expect(result).toMatchObject({
      provider: "anthropic",
      model: "claude-process",
      text: "snapshot pong",
    });
  });

  it("derives trusted inference attribution inside the Kernel", async () => {
    const managedInference = { generate: vi.fn() };
    const logicalRequestId = await inferenceLogicalRequestId([
      "kernel",
      "inst_managed",
      1000,
      "task-1",
      "run-1",
      "frame-1",
    ]);
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.attribution).toMatchObject({
        installationId: "inst_managed",
        workload: "kernel",
        actor: {
          localUid: 1000,
          processId: "task-1",
          runId: "run-1",
        },
      });
      expect(request.attribution.logicalRequestId).toBe(logicalRequestId);
      return {
        role: "assistant",
        content: [{ type: "text", text: "managed pong" }],
        api: "gsv-inference",
        provider: "gsv",
        model: "gsv/default",
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeAiConfigContext({
        "config/ai/models": JSON.stringify({
          version: 1,
          models: [{ id: "managed", name: "Managed", provider: "gsv", model: "default" }],
        }),
      }, {
        processId: "task-1",
      }),
      installationId: "inst_managed",
      processRunId: "run-1",
      requestId: "frame-1",
      env: {
        INSTALLATION_DIRECTORY: {},
        MANAGED_INFERENCE: managedInference,
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
    }, ctx);

    expect(result.text).toBe("managed pong");
    expect(createGenerationServiceMock).toHaveBeenCalledWith({
      providers: [expect.objectContaining({ id: "gsv" })],
    });
  });

  it("preserves an explicit blank credential in a complete request model", async () => {
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
        modelConfig: {
          provider: "anthropic",
          model: "claude-test",
          apiKey: "",
        },
      },
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "saved", name: "Saved", provider: "anthropic", model: "saved-model" }],
      }),
      "users/1000/ai/models/saved/api_key": "saved-key",
    }));
  });

  it("does not inherit stored connection fields into a complete request model", async () => {
    generateMock.mockImplementationOnce(async (request: any) => {
      expect(request.config).toMatchObject({
        executor: { kind: "kernel" },
        provider: "custom",
        model: "local-chat",
        apiKey: "",
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
        modelId: "local",
        modelConfig: {
          provider: "custom",
          model: "local-chat",
          providerStyle: "openai-chat-completions",
        },
      },
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{
          id: "local",
          name: "Local",
          provider: "custom",
          model: "local-chat",
          baseUrl: "http://old.example/v1",
          providerStyle: "openai-chat-completions",
        }],
      }),
      "users/1000/ai/models/local/api_key": "old-endpoint-key",
    }));
  });

  it("retains an entry credential only for the same request-local connection", async () => {
    const result = await handleAiConfig({
      modelId: "saved",
      modelConfig: {
        provider: "anthropic",
        model: "claude-test",
        maxTokens: 16_384,
      },
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "saved", name: "Saved", provider: "anthropic", model: "claude-test" }],
      }),
      "users/1000/ai/models/saved/api_key": "saved-key",
    }));

    expect(result.apiKey).toBe("saved-key");
    expect(result.maxTokens).toBe(16_384);
  });

  it("does not expose system OAuth to a changed request-local connection", async () => {
    const ctx = makeAiConfigContext({
      "config/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "codex", name: "Codex", provider: "openai-codex", model: "gpt-5.5" }],
      }),
    }, {
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

    const result = await handleAiConfig({
      modelId: "codex",
      modelConfig: {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
      },
    }, ctx);

    expect(result.apiKey).toBe("user-codex-access-token");
    expect(ctx.oauth.findAccountByIdentity).toHaveBeenCalledWith(
      1000,
      "ai-provider",
      "openai-codex",
      "default",
    );
    expect(ctx.oauth.findAccountByIdentity).not.toHaveBeenCalledWith(
      0,
      "ai-provider",
      "openai-codex",
      "default",
    );
  });

  it("builds a routed fetch for built-in text generation targets", async () => {
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

    const device = makeDevice({
      target_id: "linux-machine",
      implements: ["net.fetch"],
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeAiConfigContext(),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => device),
        listForUser: vi.fn(() => [device]),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-test",
          transportTarget: "linux-machine",
        },
      },
    }, ctx, {
      requestTarget: vi.fn(),
    });

    expect(result.text).toBe("pong");
    expect(createGenerationServiceMock).toHaveBeenCalledWith({
      fetch: expect.any(Function),
    });
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
      target_id: "linux-machine",
      implements: ["net.fetch"],
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    const ctx = {
      ...makeAiConfigContext({}, {
        oauthAccounts: [
          makeOAuthAccount({
            accessToken: "codex-access-token",
            metadata: { chatgptAccountId: "chatgpt-account-1" },
          }),
        ],
      }),
      targets: {
        canAccess: vi.fn(() => true),
        get: vi.fn(() => device),
        listForUser: vi.fn(() => [device]),
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;

    const result = await handleAiTextGenerate({
      messages: [{ role: "user", content: "ping" }],
      config: {
        modelConfig: {
          provider: "openai-codex",
          model: "gpt-5.4-mini",
          apiKey: "",
          transportTarget: "linux-machine",
        },
      },
    }, ctx, {
      requestTarget: vi.fn(),
    });

    expect(result.text).toBe("pong");
    expect(createGenerationServiceMock).toHaveBeenCalledWith({
      fetch: expect.any(Function),
    });
  });

  it("falls back to the owning human's AI config for agent processes", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "owner", name: "Owner", provider: "owner-provider", model: "owner-model", maxTokens: 1234, contextWindowTokens: 2222 }],
      }),
      "users/1000/ai/models/owner/api_key": "owner-key",
      "users/1000/ai/reasoning": "high",
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

  it("resolves one owner-ordered model stack without field-level inheritance", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [
          {
            id: "primary",
            name: "Primary",
            provider: "openrouter",
            model: "openai/gpt-5-mini",
            baseUrl: "https://openrouter.ai/api/v1",
            providerStyle: "openai-chat-completions",
            maxTokens: 16_384,
            contextWindowTokens: 128_000,
          },
          {
            id: "local",
            name: "Local",
            provider: "custom",
            model: "qwen",
            baseUrl: "http://127.0.0.1:8080/v1",
            transportTarget: "home-server",
          },
          {
            id: "workers-backup",
            name: "Workers backup",
            provider: "workers-ai",
            model: "@cf/backup/model",
          },
        ],
      }),
      "users/1000/ai/models/primary/api_key": "primary-key",
      "users/1000/ai/models/local/api_key": "local-key",
      // These legacy values must not leak into complete canonical entries.
      "users/1000/ai/provider": "stale-provider",
      "users/1000/ai/model": "stale-model",
      "users/1000/ai/max_tokens": "8192",
    }));

    expect(result).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "primary-key",
      maxTokens: 16_384,
      contextWindowTokens: 128_000,
    });
    expect(result.fallbacks).toEqual([
      expect.objectContaining({
        modelId: "local",
        modelName: "Local",
        provider: "custom",
        model: "qwen",
        apiKey: "local-key",
        baseUrl: "http://127.0.0.1:8080/v1",
        transportTarget: "home-server",
        maxTokens: 32_768,
      }),
      expect.objectContaining({
        modelId: "workers-backup",
        modelName: "Workers backup",
        provider: "workers-ai",
        model: "@cf/backup/model",
        apiKey: "",
        maxTokens: 32_768,
      }),
      expect.objectContaining({
        modelId: "workers-ai-glm-5-3-flash",
        provider: "workers-ai",
        model: "@cf/zai-org/glm-5.3-flash",
        apiKey: "",
      }),
      expect.objectContaining({
        modelId: "workers-ai-kimi-k2-6",
        provider: "workers-ai",
        model: "@cf/moonshotai/kimi-k2.6",
        apiKey: "",
      }),
    ]);
  });

  it("moves a Process model preference ahead of the owner's remaining stack", async () => {
    const stack = JSON.stringify({
      version: 1,
      models: [
        { id: "primary", name: "Primary", provider: "openai", model: "gpt-primary" },
        { id: "preferred", name: "Preferred", provider: "anthropic", model: "claude-preferred" },
        { id: "last", name: "Last", provider: "workers-ai", model: "@cf/last" },
      ],
    });
    const result = await handleAiConfig({
      modelId: "preferred",
    }, makeAiConfigContext({
      "users/1000/ai/models": stack,
    }));

    expect([result.model, ...(result.fallbacks ?? []).map((fallback) => fallback.model)])
      .toEqual([
        "claude-preferred",
        "gpt-primary",
        "@cf/last",
        "@cf/zai-org/glm-5.3-flash",
        "@cf/moonshotai/kimi-k2.6",
      ]);
  });

  it("rejects a requested model id that is not in the owner's stack", async () => {
    await expect(handleAiConfig({
      modelId: "missing",
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "primary", name: "Primary", provider: "workers-ai", model: "@cf/primary" }],
      }),
    }))).rejects.toThrow("AI model not found: missing");
  });

  it("uses the canonical system stack when the owner has no text-model config", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/models": JSON.stringify({
        version: 1,
        models: [
          { id: "system-primary", name: "System primary", provider: "workers-ai", model: "@cf/primary" },
          { id: "system-fallback", name: "System fallback", provider: "workers-ai", model: "@cf/fallback" },
        ],
      }),
    }));

    expect(result.model).toBe("@cf/primary");
    expect(result.fallbacks).toEqual([
      expect.objectContaining({
        modelId: "system-fallback",
        model: "@cf/fallback",
      }),
      expect.objectContaining({
        modelId: "workers-ai-glm-5-3-flash",
        provider: "workers-ai",
        model: "@cf/zai-org/glm-5.3-flash",
        apiKey: "",
      }),
      expect.objectContaining({
        modelId: "workers-ai-kimi-k2-6",
        provider: "workers-ai",
        model: "@cf/moonshotai/kimi-k2.6",
        apiKey: "",
      }),
    ]);
  });

  it("supplies GSV Included as the managed base when nothing is configured", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({}, { managedInference: true }));

    expect(result).toMatchObject({ provider: "gsv", model: "default", apiKey: "" });
    expect(result.fallbacks).toBeUndefined();
  });

  it("extends the managed base with a personal provider instead of replacing it", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "mine", name: "Mine", provider: "openai", model: "gpt-5.4" }],
      }),
      "users/1000/ai/models/mine/api_key": "sk-mine",
    }, { managedInference: true }));

    expect(result).toMatchObject({ provider: "openai", model: "gpt-5.4", apiKey: "sk-mine" });
    expect(result.fallbacks).toEqual([
      expect.objectContaining({ modelId: "gsv-included", provider: "gsv", model: "default", apiKey: "" }),
    ]);
  });

  it("promotes a preferred base entry ahead of personal entries", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "mine", name: "Mine", provider: "openai", model: "gpt-5.4" }],
      }),
      "users/1000/ai/preferred_model": "gsv-included",
    }, { managedInference: true }));

    expect(result).toMatchObject({ provider: "gsv", model: "default" });
    expect(result.fallbacks?.map((fallback) => fallback.modelId)).toEqual(["mine"]);
  });

  it("keeps one copy when a configured list repeats a base model", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "setup-primary", name: "GSV Included", provider: "gsv", model: "default" }],
      }),
    }, { managedInference: true }));

    expect(result).toMatchObject({ provider: "gsv", model: "default" });
    expect(result.fallbacks).toBeUndefined();
  });

  it("layers the system list between personal entries and the base", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "mine", name: "Mine", provider: "openai", model: "gpt-5.4" }],
      }),
      "config/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "shared", name: "Shared", provider: "anthropic", model: "claude-sonnet-5" }],
      }),
      "config/ai/models/shared/api_key": "sk-shared",
    }, { managedInference: true }));

    expect(result.model).toBe("gpt-5.4");
    expect(result.fallbacks?.map((fallback) => [fallback.modelId, fallback.apiKey])).toEqual([
      ["shared", "sk-shared"],
      ["gsv-included", ""],
    ]);
  });

  it("lists the effective stack with its layers through ai.models", () => {
    const ctx = makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "mine", name: "Mine", provider: "openai", model: "gpt-5.4" }],
      }),
      "users/1000/ai/models/mine/api_key": "sk-mine",
    }, { managedInference: true });

    expect(handleAiModels(ctx)).toEqual({
      preferredModelId: null,
      models: [
        expect.objectContaining({ id: "mine", source: "personal", hasCredential: true }),
        expect.objectContaining({ id: "gsv-included", name: "GSV Included", source: "base", hasCredential: false }),
      ],
    });
    expect(JSON.stringify(handleAiModels(ctx))).not.toContain("sk-mine");

    const preferred = handleAiModels(makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "mine", name: "Mine", provider: "openai", model: "gpt-5.4" }],
      }),
      "users/1000/ai/preferred_model": "gsv-included",
    }, { managedInference: true }));
    expect(preferred.preferredModelId).toBe("gsv-included");
    expect(preferred.models.map((model) => model.id)).toEqual(["gsv-included", "mine"]);
  });

  it("validates one complete request-local model without adding stored fallbacks", async () => {
    const result = await handleAiConfig({
      modelId: "primary",
      modelConfig: {
        provider: "custom",
        model: "draft-model",
        baseUrl: "https://draft.example/v1",
        apiKey: "draft-key",
        maxTokens: 12345,
      },
    }, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [
          { id: "primary", name: "Primary", provider: "openai", model: "stored-model" },
          { id: "fallback", name: "Fallback", provider: "workers-ai", model: "@cf/fallback" },
        ],
      }),
      "users/1000/ai/models/primary/api_key": "stored-key",
    }));

    expect(result).toMatchObject({
      provider: "custom",
      model: "draft-model",
      baseUrl: "https://draft.example/v1",
      apiKey: "draft-key",
      maxTokens: 12345,
    });
    expect(result.fallbacks).toBeUndefined();
  });

  it("rejects an explicitly malformed owner model stack instead of silently changing models", async () => {
    await expect(handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({ version: 1, models: [] }),
    }))).rejects.toThrow("Invalid AI model stack at /sys/users/1000/ai/models");
  });

  it("uses the owner's complete stack for an agent process", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "owner", name: "Owner", provider: "owner-provider", model: "owner-model" }],
      }),
      "users/1000/ai/models/owner/api_key": "owner-key",
      "users/2000/ai/models": JSON.stringify({
        version: 1,
        models: [{ id: "agent", name: "Agent", provider: "agent-provider", model: "agent-model" }],
      }),
      "users/2000/ai/models/agent/api_key": "agent-key",
      "users/1000/ai/tools/approval": '{"default":"deny","rules":[]}',
      "users/2000/ai/tools/approval": '{"default":"auto","rules":[]}',
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("owner-provider");
    expect(result.model).toBe("owner-model");
    expect(result.apiKey).toBe("owner-key");
    expect(result.accountApprovalPolicy).toBe('{"default":"auto","rules":[]}');
  });

  it("keeps a complete request-local model separate from persisted runtime and media settings", async () => {
    const result = await handleAiConfig({
      modelConfig: {
        provider: "openai",
        model: "gpt-4.1-mini",
        apiKey: "request-key",
        maxTokens: 2048,
        contextWindowTokens: 64000,
      },
      reasoning: "low",
    }, makeAiConfigContext({
      "users/1000/ai/max_context_bytes": "12000",
      "users/1000/ai/generation/timeout_ms": "45000",
      "users/1000/ai/image/read/max_tokens": "777",
      "users/1000/ai/image/read/max_objects": "55",
    }));

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(result.apiKey).toBe("request-key");
    expect(result.reasoning).toBe("low");
    expect(result.maxTokens).toBe(2048);
    expect(result.contextWindowTokens).toBe(64000);
    expect(result.contextWindowSource).toBe("config");
    expect(result.maxContextBytes).toBe(12000);
    expect(result.generationTimeoutMs).toBe(45000);
    expect(result.media).toMatchObject({
      imageReadingMaxTokens: 777,
      imageReadingMaxObjects: 55,
      imageGenerationProvider: "workers-ai",
      imageGenerationApiKey: "",
      transcriptionProvider: "workers-ai",
      transcriptionApiKey: "",
      speechProvider: "workers-ai",
      speechApiKey: "",
    });
  });

  it("resolves the media model stack with owner fallback", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/transcription/provider": "workers-ai",
      "users/1000/ai/transcription/model": "@cf/openai/whisper-tiny-en",
      "users/1000/ai/transcription/api_key": "owner-transcription-key",
      "users/1000/ai/image/read/max_bytes": "12345",
      "users/1000/ai/image/read/max_tokens": "321",
      "users/1000/ai/image/read/max_objects": "22",
      "users/1000/ai/image/read/timeout_ms": "9876",
      "users/1000/ai/image/generation/provider": "openai",
      "users/1000/ai/image/generation/model": "@cf/owner/image",
      "users/1000/ai/image/generation/api_key": "owner-image-key",
      "users/1000/ai/speech/provider": "openai",
      "users/1000/ai/speech/model": "@cf/owner/speech",
      "users/1000/ai/speech/api_key": "owner-speech-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.media).toMatchObject({
      transcriptionProvider: "workers-ai",
      transcriptionModel: "@cf/openai/whisper-tiny-en",
      transcriptionApiKey: "owner-transcription-key",
      imageReadingMaxBytes: 12345,
      imageReadingMaxTokens: 321,
      imageReadingMaxObjects: 22,
      imageReadingTimeoutMs: 9876,
      imageGenerationProvider: "openai",
      imageGenerationModel: "@cf/owner/image",
      imageGenerationApiKey: "owner-image-key",
      speechProvider: "openai",
      speechModel: "@cf/owner/speech",
      speechApiKey: "owner-speech-key",
    });
  });

  it("includes default media stack values", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext());

    expect(result.media?.imageReadingMaxBytes).toBe(10 * 1024 * 1024);
    expect(result.media?.imageReadingMaxTokens).toBe(DEFAULT_IMAGE_READING_MAX_TOKENS);
    expect(result.media?.imageReadingMaxObjects).toBe(DEFAULT_IMAGE_READING_MAX_OBJECTS);
    expect(result.media?.imageReadingTimeoutMs).toBe(30_000);
    expect(result.media?.speechProvider).toBe("workers-ai");
    expect(result.media?.speechModel).toBe("@cf/deepgram/aura-2-en");
    expect(result.media?.speechApiKey).toBe("");
    expect(result.media?.transcriptionProvider).toBe("workers-ai");
    expect(result.media?.transcriptionModel).toBe(DEFAULT_AUDIO_TRANSCRIPTION_MODEL);
    expect(result.media?.transcriptionApiKey).toBe("");
  });

  it("rejects partial media model overrides instead of mixing configurations", async () => {
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/transcription/provider": "openai",
    }))).rejects.toThrow(
      "AI model configuration at /sys/config/ai/transcription must include provider and model",
    );
  });

  it("keeps each media credential attached to its complete model configuration", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "config/ai/api_key": "detached-key-must-be-ignored",
      "config/ai/transcription/provider": "openai",
      "config/ai/transcription/model": "gpt-4o-transcribe",
      "config/ai/transcription/api_key": "transcription-key",
      "config/ai/image/generation/provider": "openai",
      "config/ai/image/generation/model": "gpt-image-1.5",
      "config/ai/image/generation/api_key": "image-key",
      "config/ai/speech/provider": "openai",
      "config/ai/speech/model": "gpt-4o-mini-tts",
      "config/ai/speech/api_key": "speech-key",
      "config/ai/speech/speaker": "alloy",
    }));
    expect(result.media).toMatchObject({
      transcriptionProvider: "openai",
      transcriptionModel: "gpt-4o-transcribe",
      transcriptionApiKey: "transcription-key",
      imageGenerationProvider: "openai",
      imageGenerationModel: "gpt-image-1.5",
      imageGenerationApiKey: "image-key",
      speechProvider: "openai",
      speechModel: "gpt-4o-mini-tts",
      speechApiKey: "speech-key",
      speechSpeaker: "alloy",
    });
  });
});

describe("handleAiTranscriptionCreate", () => {
  function makeTranscriptionContext(options: {
    config?: Record<string, string>;
    response?: KernelTestValue;
  } = {}): KernelContext {
    const config = options.config ?? {};
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId: TEST_INSTALLATION_ID,
      peer: testPeer({ kind: "human", account: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        }, calls: ["*"] }),
      config: makeTestConfig(config),
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({
            text: "turn on the office lights",
            transcription_info: { duration: 1.25, language: "en" },
          })),
        },
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
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

  it("uses the requested process account's complete transcription configuration", async () => {
    const ctx = makeTranscriptionContext({
      config: {
        "users/2000/ai/transcription/provider": "workers-ai",
        "users/2000/ai/transcription/model": "@cf/agent/transcriber",
        "users/2000/ai/transcription/api_key": "agent-key",
        "users/1000/ai/transcription/provider": "workers-ai",
        "users/1000/ai/transcription/model": "@cf/owner/transcriber",
        "users/1000/ai/transcription/api_key": "owner-key",
      },
    });
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    (ctx as { procs: KernelTestValue }).procs = {
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    (ctx as { auth: KernelTestValue }).auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "sam",
        home: "/home/sam",
      })),
      resolveGids: vi.fn(() => [1000]),
    };
    const result = await handleAiTranscriptionCreate({
      pid: "proc:agent",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/agent/transcriber");
  });

  it("rejects cross-owner process configuration access", async () => {
    const ctx = makeTranscriptionContext();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    (ctx as { procs: KernelTestValue }).procs = {
      get: vi.fn(() => ({ ownerUid: 2000 })),
      getOwnerUid: vi.fn(() => 1000),
    };

    await expect(handleAiTranscriptionCreate({
      pid: "proc:other",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])))).rejects.toThrow(
      "Permission denied: cannot access process proc:other",
    );
  });

  it("allows root to use another process account's transcription configuration", async () => {
    const ctx = makeTranscriptionContext({
      config: {
        "users/2000/ai/transcription/provider": "workers-ai",
        "users/2000/ai/transcription/model": "@cf/root-selected/transcriber",
        "users/2000/ai/transcription/api_key": "",
      },
    });
    principalOf(ctx)!.account.uid = 0;
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    (ctx as { procs: KernelTestValue }).procs = {
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    (ctx as { auth: KernelTestValue }).auth = {
      getPasswdByUid: vi.fn(() => ({
        uid: 1000,
        gid: 1000,
        username: "sam",
        home: "/home/sam",
      })),
      resolveGids: vi.fn(() => [1000]),
    };
    const result = await handleAiTranscriptionCreate({
      pid: "proc:other",
      audio: { mimeType: "audio/webm" },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(result.model).toBe("@cf/root-selected/transcriber");
  });

  it("does not start a fallback after caller cancellation", async () => {
    const controller = new AbortController();
    const ctx = makeTranscriptionContext();
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
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
        "config/ai/transcription/provider": "workers-ai",
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
        // SAFETY: test fixture is constructed with the asserted kernel domain shape.
        data: "AQID",
      },
    }, ctx)).rejects.toThrow("audio request body is required");
  });
});

describe("handleAiImageRead", () => {
  function makeImageReadContext(options: {
    config?: Record<string, string>;
    response?: KernelTestValue;
  } = {}): KernelContext {
    const config = options.config ?? {};
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId: TEST_INSTALLATION_ID,
      peer: testPeer({ kind: "human", account: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        }, calls: ["*"] }),
      config: makeTestConfig(config),
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({
            caption: "A small terminal window with green text.",
          })),
        },
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
  }

  it("reads images through the fixed Moondream caption path", async () => {
    const ctx = makeImageReadContext();

    const response = await handleAiImageRead({
      image: {
        mimeType: "image/png",
      },
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(response.data).toEqual(expect.objectContaining({
      mode: "caption",
      text: "A small terminal window with green text.",
      model: DEFAULT_IMAGE_READING_MODEL,
    }));
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_READING_MODEL,
      expect.objectContaining({
        task: "caption",
        caption_length: "normal",
        max_tokens: DEFAULT_IMAGE_READING_MAX_TOKENS,
        image: "data:image/png;base64,AQID",
      }),
    );
  });

  it("honors resource limits but ignores obsolete image-reader dialect config", async () => {
    const ctx = makeImageReadContext({
      config: {
        "users/1000/ai/image/read/max_tokens": "77",
        "users/1000/ai/image/read/max_objects": "12",
      },
      response: {
        objects: [{ x_min: 0.1, y_min: 0.2, x_max: 0.3, y_max: 0.4 }],
      },
    });

    const response = await handleAiImageRead({
      image: {
        mimeType: "image/png",
      },
      mode: "detect",
      target: "button",
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(response.data).toEqual(expect.objectContaining({
      mode: "detect",
      model: DEFAULT_IMAGE_READING_MODEL,
      objects: [{ xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 }],
    }));
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_READING_MODEL,
      {
        image: "data:image/png;base64,AQID",
        stream: false,
        task: "detect",
        target: "button",
        max_objects: 12,
      },
    );
  });

  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  it("returns decoded streaming output as a response body", async () => {
    const encoded = new TextEncoder().encode("data: {\"text\":\"hello\"}\n\n");
    const ctx = makeImageReadContext({
      response: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
    });

    const response = await handleAiImageRead({
      image: { mimeType: "image/png" },
      mode: "caption",
      stream: true,
    }, ctx, bodyFromBytes(new Uint8Array([1, 2, 3])));

    expect(response.data).toEqual(expect.objectContaining({ streamed: true }));
    expect(response.body).toBeDefined();
    expect(new TextDecoder().decode(await bodyToBytes(response.body!))).toBe("hello");
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
    let cancelled: KernelTestValue;
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
    response?: KernelTestValue;
  } = {}): KernelContext {
    const config = options.config ?? {};
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId: TEST_INSTALLATION_ID,
      peer: testPeer({ kind: "human", account: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        }, calls: ["*"] }),
      config: makeTestConfig(config),
      env: {
        AI: {
          run: vi.fn(async () => options.response ?? ({ image: "AQID" })),
        },
      },
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
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

  it("uses a complete account image-generation configuration", async () => {
    const ctx = makeImageGenerateContext({
      config: {
        "users/1000/ai/image/generation/provider": "workers-ai",
        "users/1000/ai/image/generation/model": "@cf/black-forest-labs/flux-1-schnell",
        "users/1000/ai/image/generation/api_key": "",
      },
    });

    const result = await handleAiImageGenerate({ prompt: "a blue terminal" }, ctx);

    expect(result.data.model).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/black-forest-labs/flux-1-schnell",
      { prompt: "a blue terminal" },
    );
  });

  it("uses the credential attached to the account image configuration", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const ctx = makeImageGenerateContext({
      config: {
        "users/1000/ai/image/generation/provider": "openai",
        "users/1000/ai/image/generation/model": "gpt-image-1",
        "users/1000/ai/image/generation/api_key": "sk-image",
      },
    });

    try {
      const result = await handleAiImageGenerate({ prompt: "a profile terminal" }, ctx);

      expect(result.data.provider).toBe("openai");
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/images/generations"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-image",
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires a prompt", async () => {
    await expect(handleAiImageGenerate({ prompt: "" }, makeImageGenerateContext())).rejects.toThrow("prompt is required");
  });
});

describe("handleAiSpeechCreate", () => {
  function makeSpeechContext(options: {
    config?: Record<string, string>;
    response?: KernelTestValue;
  } = {}): KernelContext {
    const config = options.config ?? {};
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    return {
      installationId: TEST_INSTALLATION_ID,
      peer: testPeer({ kind: "human", account: {
          uid: 1000,
          gid: 1000,
          gids: [1000],
          username: "sam",
          home: "/home/sam",
          cwd: "/home/sam",
        }, calls: ["*"] }),
      config: makeTestConfig(config),
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
    // SAFETY: test fixture is constructed with the asserted kernel domain shape.
    } as KernelContext;
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
    expect(result.data.model).toBe("@cf/deepgram/aura-2-en");
    expect(result.data.voice).toBe("luna");
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-2-en",
      expect.objectContaining({
        text: "Hello GSV",
        speaker: "luna",
        encoding: "mp3",
      }),
    );
  });

  it("uses a complete account speech configuration", async () => {
    const ctx = makeSpeechContext({
      config: {
        "users/1000/ai/speech/provider": "workers-ai",
        "users/1000/ai/speech/model": "@cf/deepgram/aura-1",
        "users/1000/ai/speech/api_key": "",
        "users/1000/ai/speech/speaker": "orpheus",
        "users/1000/ai/speech/encoding": "wav",
      },
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
      "@cf/deepgram/aura-2-en",
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
      "@cf/deepgram/aura-2-en",
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
        "config/ai/speech/provider": "workers-ai",
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
