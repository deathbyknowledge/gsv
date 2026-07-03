import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import {
  DEFAULT_WORKERS_AI_MODEL,
  buildWorkersAiInput,
  buildWorkersAiRunOptions,
  completeWithWorkersAi,
  contextToWorkersAiMessages,
  extractWorkersAiContextWindow,
  hasWorkersAiModelPricing,
  normalizeWorkersAiResponse,
  streamWithWorkersAi,
} from "./workers-ai";
import { DEFAULT_WORKERS_AI_FALLBACK_MODEL } from "./default-models";

describe("contextToWorkersAiMessages", () => {
  it("serializes system, assistant tool calls, and tool results", () => {
    const context: Context = {
      systemPrompt: "system prompt",
      messages: [
        {
          role: "user",
          content: "Find the repo status",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect git status." },
            {
              type: "toolCall",
              id: "call_1",
              name: "shell.exec",
              arguments: { input: "git status --short" },
            },
          ],
          api: "test",
          provider: "test",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "shell.exec",
          content: [{ type: "text", text: "M src/app.ts" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };

    const messages = contextToWorkersAiMessages(context);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "system", content: "system prompt" });
    expect(messages[1]).toEqual({ role: "user", content: "Find the repo status" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "I will inspect git status.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "shell.exec",
            arguments: JSON.stringify({ input: "git status --short" }),
          },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      content: "M src/app.ts",
      tool_call_id: "call_1",
    });
  });

  it("uses stored image descriptions for Workers AI text models", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            {
              type: "text",
              text: "Attached image \"screen.png\" [image/png] 3 B\nImage description: A settings page with a Save button.",
            },
            { type: "image", data: "AQID", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };

    const messages = contextToWorkersAiMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Image description: A settings page with a Save button.");
    expect(messages[0]?.content).not.toContain("multi-modality");
    expect(messages[0]?.content).not.toContain("Attached image omitted");
  });

  it("keeps omission notes for images without paired descriptions", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare these images." },
            {
              type: "text",
              text: "Attached image \"described.png\" [image/png] 3 B\nImage description: A blue chart.",
            },
            { type: "image", data: "AQID", mimeType: "image/png" },
            { type: "image", data: "BAUG", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };

    const messages = contextToWorkersAiMessages(context);
    const content = messages[0]?.content ?? "";
    const omissionNotes = content.match(/Attached image omitted/g) ?? [];

    expect(messages).toHaveLength(1);
    expect(content).toContain("Image description: A blue chart.");
    expect(omissionNotes).toHaveLength(1);
    expect(content).not.toContain("multi-modality");
  });

  it("keeps an explicit omission note when no image description is available", () => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image", data: "AQID", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };

    const messages = contextToWorkersAiMessages(context);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Attached image omitted");
    expect(messages[0]?.content).not.toContain("multi-modality");
  });
});

describe("buildWorkersAiInput", () => {
  it("maps tools and disables reasoning when unset", () => {
    const input = buildWorkersAiInput({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 512,
      context: {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "fs.read",
            description: "Read a file",
            parameters: Type.Object({
              path: Type.String(),
            }),
          },
        ],
      },
    });

    expect(input.max_completion_tokens).toBe(512);
    expect(input.parallel_tool_calls).toBe(true);
    expect(input.reasoning_effort).toBeUndefined();
    expect(input.chat_template_kwargs).toEqual({
      enable_thinking: false,
      clear_thinking: true,
    });
    expect(input.tools).toHaveLength(1);
    expect(input.tools?.[0]?.type).toBe("function");
    expect(input.tools?.[0]?.function.name).toBe("fs.read");
    expect(input.tools?.[0]?.function.description).toBe("Read a file");
    expect(input.tools?.[0]?.function.strict).toBe(false);
    expect(input.tools?.[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    });
  });

  it("passes through reasoning effort when enabled", () => {
    const input = buildWorkersAiInput({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 256,
      reasoning: "high",
      context: {
        messages: [],
      },
    });

    expect(input.reasoning_effort).toBe("high");
    expect(input.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("uses the Kimi thinking flag for the shipped fallback model", () => {
    const input = buildWorkersAiInput({
      modelName: DEFAULT_WORKERS_AI_FALLBACK_MODEL,
      maxTokens: 256,
      reasoning: "medium",
      context: {
        messages: [],
      },
    });

    expect(input.reasoning_effort).toBe("medium");
    expect(input.chat_template_kwargs).toEqual({ thinking: true });
  });

  it("disables Kimi thinking with the Kimi-specific flag", () => {
    const input = buildWorkersAiInput({
      modelName: DEFAULT_WORKERS_AI_FALLBACK_MODEL,
      maxTokens: 256,
      context: {
        messages: [],
      },
    });

    expect(input.reasoning_effort).toBeUndefined();
    expect(input.chat_template_kwargs).toEqual({ thinking: false });
  });

  it("builds session affinity headers when requested", () => {
    const options = buildWorkersAiRunOptions({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 256,
      sessionAffinityKey: "proc-123",
      context: {
        messages: [],
      },
    });

    expect(options).toEqual({
      headers: {
        "x-session-affinity": "proc-123",
      },
    });
  });
});

describe("completeWithWorkersAi", () => {
  it("falls back without tools for non-timeout tool request errors", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("tool schema unsupported"))
      .mockResolvedValueOnce({ response: "fallback response" });
    (env as unknown as { AI: { run: typeof run } }).AI = { run };

    const response = await completeWithWorkersAi({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 128,
      timeoutMs: 1000,
      context: toolContext(),
    });

    expect(response.content).toEqual([{ type: "text", text: "fallback response" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      tools: expect.any(Array),
    });
    expect(run.mock.calls[1]?.[1]).not.toHaveProperty("tools");
  });

  it("does not retry timed-out tool requests without tools", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise(() => {}));
    (env as unknown as { AI: { run: typeof run } }).AI = { run };

    try {
      const promise = completeWithWorkersAi({
        modelName: DEFAULT_WORKERS_AI_MODEL,
        maxTokens: 128,
        timeoutMs: 10,
        context: toolContext(),
      });

      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).rejects.toMatchObject({
        name: "TimeoutError",
        message: "Workers AI generation timed out after 10ms",
      });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("streamWithWorkersAi", () => {
  it("emits pi-ai text events from Workers AI SSE chunks", async () => {
    const run = vi.fn().mockResolvedValue(sseStream([
      "data: {\"response\":\"hel\"}\n\n",
      "data: {\"response\":\"lo\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}\n\n",
      "data: [DONE]\n\n",
    ]));
    (env as unknown as { AI: { run: typeof run } }).AI = { run };

    const stream = streamWithWorkersAi({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 128,
      timeoutMs: 1000,
      context: {
        messages: [{ role: "user", content: "say hello", timestamp: 1 }],
      },
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const response = await stream.result();
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(response.usage).toMatchObject({
      input: 10,
      output: 2,
      totalTokens: 12,
    });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      stream: true,
      max_completion_tokens: 128,
    });
  });

  it("emits thinking and tool call events from OpenAI-style chunks", async () => {
    const run = vi.fn().mockResolvedValue(sseStream([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think \",\"content\":\"I'll call \",\"tool_calls\":[{\"index\":0,\"id\":\"tool_1\",\"function\":{\"name\":\"fs.read\",\"arguments\":\"{\\\"path\\\"\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"more\",\"content\":\"a tool.\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    (env as unknown as { AI: { run: typeof run } }).AI = { run };

    const stream = streamWithWorkersAi({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 128,
      timeoutMs: 1000,
      context: toolContext(),
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const response = await stream.result();
    expect(events.map((event) => event.type)).toContain("thinking_delta");
    expect(events.map((event) => event.type)).toContain("toolcall_delta");
    expect(response.stopReason).toBe("toolUse");
    expect(response.content).toEqual([
      { type: "thinking", thinking: "think more" },
      { type: "text", text: "I'll call a tool." },
      {
        type: "toolCall",
        id: "tool_1",
        name: "fs.read",
        arguments: { path: "README.md" },
      },
    ]);
  });

  it("ends reasoning-only streams as errors", async () => {
    const run = vi.fn().mockResolvedValue(sseStream([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking only\"},\"finish_reason\":\"stop\"}]}\n\n",
      "data: [DONE]\n\n",
    ]));
    (env as unknown as { AI: { run: typeof run } }).AI = { run };

    const stream = streamWithWorkersAi({
      modelName: DEFAULT_WORKERS_AI_MODEL,
      maxTokens: 128,
      timeoutMs: 1000,
      context: {
        messages: [{ role: "user", content: "answer visibly", timestamp: 1 }],
      },
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const response = await stream.result();
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "error",
    ]);
    expect(response).toMatchObject({
      stopReason: "error",
      errorMessage: "Workers AI returned reasoning but no final response",
    });
    expect(response.content).toEqual([
      { type: "thinking", thinking: "thinking only" },
    ]);
  });
});

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function toolContext(): Context {
  return {
    messages: [{ role: "user", content: "read a file", timestamp: 1 }],
    tools: [
      {
        name: "fs.read",
        description: "Read a file",
        parameters: Type.Object({
          path: Type.String(),
        }),
      },
    ],
  };
}

describe("extractWorkersAiContextWindow", () => {
  it("reads context window token metadata from model properties", () => {
    expect(extractWorkersAiContextWindow({
      id: "@cf/example/model",
      properties: [
        { property_id: "parameters", value: "120B" },
        { property_id: "context_window_tokens", value: "262.1k" },
      ],
    })).toBe(262100);
  });

  it("falls back to parsing Workers AI model descriptions", () => {
    expect(extractWorkersAiContextWindow({
      id: "@cf/zai-org/glm-4.7-flash",
      description: "GLM-4.7-Flash is a fast multilingual model with a 131,072 token context window.",
    })).toBe(131072);
    expect(extractWorkersAiContextWindow({
      id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
      description: "Mistral Small 3.1 enhances long context capabilities up to 128k tokens.",
    })).toBe(128000);
  });

  it("does not treat arbitrary model size numbers as context windows", () => {
    expect(extractWorkersAiContextWindow({
      id: "@cf/openai/gpt-oss-120b",
      description: "OpenAI's open-weight model gpt-oss-120b is for production reasoning use-cases.",
    })).toBeNull();
  });
});

describe("normalizeWorkersAiResponse", () => {
  it("normalizes OpenAI-style tool calls and usage", () => {
    const response = normalizeWorkersAiResponse(
      {
        response: "I'll use a tool.",
        tool_calls: [
          {
            id: "tool_123",
            type: "function",
            function: {
              name: "fs.read",
              arguments: "{\"path\":\"README.md\"}",
            },
          },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("toolUse");
    expect(response.content).toEqual([
      { type: "text", text: "I'll use a tool." },
      {
        type: "toolCall",
        id: "tool_123",
        name: "fs.read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(response.usage.input).toBe(1000);
    expect(response.usage.output).toBe(200);
    expect(response.usage.totalTokens).toBe(1200);
    expect(response.usage.cost.total).toBeGreaterThan(0);
  });

  it("leaves cost unknown for Workers AI models without pi-ai pricing", () => {
    expect(hasWorkersAiModelPricing(DEFAULT_WORKERS_AI_MODEL)).toBe(true);
    expect(hasWorkersAiModelPricing("@cf/example/not-priced")).toBe(false);

    const response = normalizeWorkersAiResponse(
      {
        response: "hello",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
        },
      },
      "@cf/example/not-priced",
    );

    expect(response.usage.input).toBe(1000);
    expect(response.usage.output).toBe(200);
    expect(response.usage.cost.total).toBe(0);
  });

  it("normalizes legacy tool call payloads without ids", () => {
    const response = normalizeWorkersAiResponse(
      {
        tool_calls: [
          {
            name: "shell.exec",
            arguments: { input: "pwd" },
          },
        ],
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("toolUse");
    expect(response.content).toEqual([
      {
        type: "toolCall",
        id: "workers-ai-tool-1",
        name: "shell.exec",
        arguments: { input: "pwd" },
      },
    ]);
  });

  it("marks reasoning-only responses as missing a final response", () => {
    const response = normalizeWorkersAiResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "I found the answer but did not emit it.",
            },
          },
        ],
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response).toMatchObject({
      stopReason: "error",
      errorMessage: "Workers AI returned reasoning but no final response",
    });
    expect(response.content).toEqual([
      {
        type: "thinking",
        thinking: "I found the answer but did not emit it.",
      },
    ]);
  });

  it("reads reasoning content and multiple tool calls from choices output", () => {
    const response = normalizeWorkersAiResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll do both.",
              reasoning_content: "Need two reads.",
              tool_calls: [
                {
                  id: "tool_1",
                  type: "function",
                  function: {
                    name: "fs.read",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
                {
                  id: "tool_2",
                  type: "function",
                  function: {
                    name: "fs.read",
                    arguments: "{\"path\":\"package.json\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("toolUse");
    expect(response.content).toEqual([
      {
        type: "thinking",
        thinking: "Need two reads.",
      },
      {
        type: "text",
        text: "I'll do both.",
      },
      {
        type: "toolCall",
        id: "tool_1",
        name: "fs.read",
        arguments: { path: "README.md" },
      },
      {
        type: "toolCall",
        id: "tool_2",
        name: "fs.read",
        arguments: { path: "package.json" },
      },
    ]);
  });

  it("reads chat-completions style choices output", () => {
    const response = normalizeWorkersAiResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "pong",
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("stop");
    expect(response.content).toEqual([
      { type: "text", text: "pong" },
    ]);
  });

  it("reads chat-completions choice content arrays", () => {
    const response = normalizeWorkersAiResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "hello " },
                { type: "text", text: "world" },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("stop");
    expect(response.content).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("reads responses-style output_text", () => {
    const response = normalizeWorkersAiResponse(
      {
        output_text: "hello from output_text",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("stop");
    expect(response.content).toEqual([
      { type: "text", text: "hello from output_text" },
    ]);
  });

  it("reads responses-style reasoning items", () => {
    const response = normalizeWorkersAiResponse(
      {
        output: [
          {
            type: "reasoning",
            content: [
              {
                type: "reasoning_text",
                text: "Step through the problem.",
              },
            ],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "final answer",
              },
            ],
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      DEFAULT_WORKERS_AI_MODEL,
    );

    expect(response.stopReason).toBe("stop");
    expect(response.content).toEqual([
      {
        type: "thinking",
        thinking: "Step through the problem.",
      },
      {
        type: "text",
        text: "final answer",
      },
    ]);
  });
});
