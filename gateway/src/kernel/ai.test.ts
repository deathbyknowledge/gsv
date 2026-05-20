import { describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import { handleAiSpeechCreate, handleAiTools, handleAiTranscriptionCreate } from "./ai";
import { DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "../inference/transcription";
import {
  DEFAULT_AUDIO_SPEECH_MODEL,
  DEFAULT_AUDIO_SPEECH_SPEAKER,
} from "../inference/speech";

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
        workspaceId: null,
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
  it("does not add MCP server tools to the direct LLM tool surface", async () => {
    const ctx = makeContext("ready");

    const result = await handleAiTools(ctx);

    expect(result.tools.some((tool) => tool.name.startsWith("MCP_"))).toBe(false);
    expect(result.mcpServers).toEqual(["Search"]);
    expect(result.tools.some((tool) => tool.name === "SpawnProcess")).toBe(false);
    expect(result.tools.some((tool) => tool.name === "AddSchedule")).toBe(false);
    expect(result.tools.some((tool) => tool.name === "Copy")).toBe(false);
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
          workspaceId: null,
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
          workspaceId: null,
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
