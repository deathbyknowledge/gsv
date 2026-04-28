import { describe, expect, it } from "vitest";
import { Type } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";
import {
  DEFAULT_WORKERS_AI_MODEL,
  buildWorkersAiInput,
  buildWorkersAiRunOptions,
  contextToWorkersAiMessages,
  normalizeWorkersAiResponse,
} from "./workers-ai";

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
