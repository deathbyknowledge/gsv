import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";
import { sendFrameToProcess } from "../shared/utils";

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("../inference/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../inference/service")>();
  return {
    ...actual,
    createGenerationService: () => ({
      generate: generateMock,
      stream: vi.fn(),
      generateText: vi.fn(),
    }),
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
    expect(codeModeTool?.description).toContain("declare function lookup");
    expect(codeModeTool?.description).toContain("type LookupOutput");
    expect(ctx.mcp.listTools).toHaveBeenCalledWith({ serverId: "server-1" });
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
    expect(codeModeTool?.description).toContain("declare function lookup");
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

  it("advertises visible adapter targets through the routable Shell target list", async () => {
    const ctx = {
      ...makeContext("ready"),
      env: {
        CHANNEL_WHATSAPP: { adapterShellExec: vi.fn() },
      },
      adapters: {
        identityLinks: {
          list: vi.fn(() => [{
            adapter: "whatsapp",
            accountId: "primary",
            actorId: "wa:jid:123@s.whatsapp.net",
            uid: 1000,
            createdAt: 1,
            linkedByUid: 1000,
            metadata: null,
          }]),
        },
        status: {
          list: vi.fn(() => [{
            adapter: "whatsapp",
            accountId: "primary",
            connected: true,
            authenticated: true,
            mode: "websocket",
            updatedAt: 2,
          }]),
        },
      },
    } as unknown as KernelContext;

    const result = await handleAiTools(ctx);

    expect(result.devices).toContainEqual(expect.objectContaining({
      id: "adapter:whatsapp:primary",
      label: "WhatsApp",
      platform: "adapter",
      implements: ["shell.exec"],
    }));
    const shell = result.tools.find((tool) => tool.name === "Shell");
    expect(JSON.stringify(shell?.inputSchema)).toContain("adapter:whatsapp:primary");
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
    options: { uid?: number; processId?: string; ownerUid?: number; capabilities?: string[] } = {},
  ): KernelContext {
    const uid = options.uid ?? 1000;
    const ownerUid = options.ownerUid ?? uid;
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
      processId: options.processId,
      env: {},
    } as unknown as KernelContext;
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

  it("generates text with preset config and explicit generation options", async () => {
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
  });

  it("prefers agent AI config over the owning human's config", async () => {
    const result = await handleAiConfig({}, makeAiConfigContext({
      "users/1000/ai/provider": "owner-provider",
      "users/1000/ai/model": "owner-model",
      "users/1000/ai/api_key": "owner-key",
      "users/2000/ai/provider": "agent-provider",
      "users/2000/ai/model": "agent-model",
      "users/2000/ai/api_key": "agent-key",
    }, {
      uid: 2000,
      ownerUid: 1000,
      processId: "task-1",
    }));

    expect(result.provider).toBe("agent-provider");
    expect(result.model).toBe("agent-model");
    expect(result.apiKey).toBe("agent-key");
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

  it("transcribes audio through the shared Workers AI path", async () => {
    const ctx = makeTranscriptionContext();

    const result = await handleAiTranscriptionCreate({
      audio: {
        data: "data:audio/webm;base64,AQID",
        mimeType: "audio/webm",
      },
      prompt: "short command",
    }, ctx);

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
    );
  });

  it("honors process-local transcription media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeTranscriptionContext(), {
      "config/ai/transcription/model": "@cf/openai/whisper-large-v3-turbo",
      "config/ai/transcription/max_bytes": "8",
    });

    const result = await handleAiTranscriptionCreate({
      audio: {
        data: "AQID",
        mimeType: "audio/ogg",
      },
    }, ctx);

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
    );
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
        data: "AQID",
        mimeType: "audio/ogg",
      },
    }, ctx)).rejects.toThrow("exceeds transcription limit");
  });

  it("rejects non-audio payloads", async () => {
    const ctx = makeTranscriptionContext();

    await expect(handleAiTranscriptionCreate({
      audio: {
        data: "AQID",
        mimeType: "text/plain",
      },
    }, ctx)).rejects.toThrow("audio MIME type");
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
            response: "A small terminal window with green text.",
          })),
        },
      },
    } as unknown as KernelContext;
  }

  it("reads images through the configured Workers AI vision path", async () => {
    const ctx = makeImageReadContext();

    const result = await handleAiImageRead({
      image: {
        data: "data:image/png;base64,AQID",
        mimeType: "image/png",
      },
      prompt: "read this screenshot",
    }, ctx);

    expect(result.text).toBe("A small terminal window with green text.");
    expect(result.model).toBe(DEFAULT_IMAGE_READING_MODEL);
    expect(ctx.env.AI.run).toHaveBeenCalledWith(
      DEFAULT_IMAGE_READING_MODEL,
      expect.objectContaining({
        max_completion_tokens: DEFAULT_IMAGE_READING_MAX_TOKENS,
        messages: expect.any(Array),
      }),
    );
  });

  it("honors process-local image reading media overrides", async () => {
    const ctx = attachProcessAiSnapshot(makeImageReadContext(), {
      "config/ai/image/read/model": "@cf/llava-hf/llava-1.5-7b-hf",
      "config/ai/image/read/max_tokens": "77",
    });

    const result = await handleAiImageRead({
      image: {
        data: "AQID",
        mimeType: "image/png",
      },
    }, ctx);

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
        data: "AQID",
        mimeType: "image/png",
      },
    }, ctx)).rejects.toThrow("exceeds image reading limit");

    await expect(handleAiImageRead({
      image: {
        data: "AQ==",
        mimeType: "text/plain",
      },
    }, makeImageReadContext())).rejects.toThrow("image MIME type");
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

    expect(result.image).toEqual({
      data: "data:image/png;base64,AQID",
      mimeType: "image/png",
      size: 3,
    });
    expect(result.model).toBe(DEFAULT_IMAGE_GENERATION_MODEL);
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

    expect(result.model).toBe("@cf/black-forest-labs/flux-1-schnell");
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

      expect(result.provider).toBe("openai");
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

    expect(result.model).toBe("@cf/example/fallback-image");
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

    expect(result.audio).toEqual({
      data: "data:audio/mpeg;base64,AQID",
      mimeType: "audio/mpeg",
      size: 3,
    });
    expect(result.provider).toBe("workers-ai");
    expect(result.model).toBe(DEFAULT_AUDIO_SPEECH_MODEL);
    expect(result.voice).toBe(DEFAULT_AUDIO_SPEECH_SPEAKER);
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

    expect(result.model).toBe("@cf/deepgram/aura-1");
    expect(result.voice).toBe("orpheus");
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
      audio: {
        data: "",
        mimeType: "",
        size: 0,
      },
      provider: "none",
      model: "none",
      skipped: true,
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

    expect(result.voice).toBe("asteria");
    expect(result.audio.data).toBe("data:audio/mpeg;base64,AQID");
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
