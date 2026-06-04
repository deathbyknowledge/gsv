import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { DeviceRecord } from "./devices";
import { handleAiConfig, handleAiSpeechCreate, handleAiTools, handleAiTranscriptionCreate } from "./ai";
import { DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "../inference/transcription";
import {
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_SPEAKER,
} from "../inference/speech";

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
    lifecycle: partial.lifecycle ?? "persistent",
    online: partial.online ?? true,
    first_seen_at: partial.first_seen_at ?? now,
    last_seen_at: partial.last_seen_at ?? now,
    connected_at: partial.connected_at ?? now,
    disconnected_at: partial.disconnected_at ?? null,
  };
}

function makeContext(connectionState: string): KernelContext {
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
    devices: {
      listForUser: vi.fn(() => []),
    },
    mcpServers: {
      list: vi.fn(() => [{
        serverId: "server-1",
        uid: 1000,
        name: "Search",
        url: "https://mcp.example.com/mcp",
        transport: "auto",
        createdAt: 1,
        updatedAt: 2,
      }]),
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
    options: { uid?: number; processId?: string; ownerUid?: number } = {},
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
        capabilities: ["*"],
      },
      config: {
        get: vi.fn((key: string) => config[key] ?? null),
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
      .resolves.toMatchObject({ generationStreaming: "auto" });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/generation/streaming": "off",
    }))).resolves.toMatchObject({ generationStreaming: "off" });
    await expect(handleAiConfig({}, makeAiConfigContext({
      "config/ai/generation/streaming": "invalid",
    }))).resolves.toMatchObject({ generationStreaming: "auto" });
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
