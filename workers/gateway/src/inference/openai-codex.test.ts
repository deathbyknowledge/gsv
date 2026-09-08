import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";
import { createGenerationService } from "./service";
import {
  completeWithOpenAiCodexFetch,
  streamWithOpenAiCodexFetch,
} from "./openai-codex";

function codexToken(accountId = "acct-test"): string {
  return jwtToken({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function jwtToken(payload: JsonObject): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function bareCodexToken(): string {
  const payload = Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url");
  return `header.${payload}.signature`;
}

function codexModel() {
  const model = getBuiltinModels("openai-codex").find((candidate) => candidate.id === "gpt-5.4-mini");
  if (!model) {
    throw new Error("missing openai-codex/gpt-5.4-mini fixture");
  }
  return model;
}

function codexTextEvents(text = "ok", modelName = "gpt-5.4-mini"): JsonObject[] {
  return [
    {
      type: "response.created",
      response: { id: "resp_1" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: modelName,
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function sseResponse(events: JsonObject[], separator = "\n\n"): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}${separator}`).join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cf-ray": "ray-test",
    },
  });
}

function requestInput(request: JsonObject | undefined): JsonObject[] {
  return z.array(jsonObjectSchema).parse(request?.input);
}

describe("OpenAI Codex routed fetch transport", () => {
  it.each(["gpt-6-astra", "gpt-5.6-sol"])("replays a completed %s tool turn through model resolution and routed fetch", async (modelName) => {
    const requests: JsonObject[] = [];
    const toolCall = {
      id: "fc_read", type: "function_call", call_id: "call_read", name: "Read",
      arguments: '{"path":"/root/example.txt"}', status: "completed",
    };
    const fetchMock: typeof fetch = async function (this: void, input, init) {
      expect(this).toBeUndefined();
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length > 1) return sseResponse(codexTextEvents("File inspected.", modelName));
      return sseResponse([
        { type: "response.created", response: { id: "response:tool" } },
        { type: "response.output_item.added", output_index: 0, item: { ...toolCall, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: toolCall.arguments },
        { type: "response.output_item.done", output_index: 0, item: toolCall },
        {
          type: "response.completed",
          response: {
            id: "response:tool", model: modelName, status: "completed",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
          },
        },
      ]);
    };
    const generation = createGenerationService({ fetch: fetchMock });
    const config = {
      executor: { kind: "kernel" as const }, provider: "openai-codex", model: modelName,
      apiKey: codexToken(), reasoning: "high", maxTokens: 4096, maxContextBytes: 32768,
    };
    const context: Context = {
      systemPrompt: "Inspect a file, then report the result.",
      messages: [{ role: "user", content: "Inspect example.txt", timestamp: 0 }],
      tools: [{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    };
    const call = await generation.generate({ config, context, sessionAffinityKey: "process:codex" });
    expect(call.stopReason).toBe("toolUse");
    const requestedTool = call.content.find((content) => content.type === "toolCall");
    expect(requestedTool).toMatchObject({ name: "Read", arguments: { path: "/root/example.txt" } });
    if (!requestedTool || requestedTool.type !== "toolCall") throw new Error("Expected a Read tool call");
    const afterTool: Context = {
      ...context,
      messages: [
        ...context.messages,
        call,
        {
          role: "toolResult", toolCallId: requestedTool.id, toolName: "Read",
          content: [{ type: "text", text: "File contents" }], isError: false, timestamp: 1,
        },
      ],
    };
    const completed = await generation.generate({
      config, context: afterTool,
      sessionAffinityKey: "process:codex",
    });
    expect(completed.stopReason).toBe("stop");
    expect(completed.content).toContainEqual(expect.objectContaining({ type: "text", text: "File inspected." }));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: modelName, reasoning: { effort: "high" }, prompt_cache_key: "process:codex",
      tools: [{ type: "function", name: "Read" }],
    });
    expect(requests[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_read", name: "Read" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_read", output: "File contents" }),
    ]));

    const followup = await generation.generate({
      config,
      context: {
        ...afterTool,
        messages: [
          ...afterTool.messages, completed,
          { role: "user", content: "Confirm the result briefly.", timestamp: 2 },
        ],
      },
      sessionAffinityKey: "process:codex",
    });
    expect(followup.stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    const replay = requestInput(requests[2]).find((item) => item.role === "assistant");
    expect(replay).toMatchObject({
      type: "message", id: "msg_1", status: "completed",
      content: [{ type: "output_text", text: "File inspected." }],
    });
    expect(replay).not.toHaveProperty("phase");
  });

  it("serializes mixed-provider history without losing signatures or JSON values", async () => {
    const model = codexModel();
    const requests: JsonObject[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return sseResponse(codexTextEvents());
    };
    const prior = await completeWithOpenAiCodexFetch({
      model, fetch: fetchMock, options: { apiKey: codexToken() },
      context: { messages: [{ role: "user", content: "Begin.", timestamp: 0 }] },
    });
    expect(prior.stopReason).toBe("stop");
    const argumentsValue = { path: "/example.txt", offset: 0, follow: false, cursor: null };
    const output = JSON.stringify({ text: "A quoted \"result\" — λ", count: 0, truncated: false, next: null });
    const foreign: AssistantMessage = {
      ...prior, provider: "deepseek", api: "openai-completions", model: "deepseek-chat", stopReason: "toolUse",
      content: [
        { type: "text", text: "Checking the file." },
        { type: "toolCall", id: "call_legacy", name: "Read", arguments: argumentsValue },
      ],
    };
    const reasoning = { type: "reasoning", id: "rs_saved", encrypted_content: "synthetic-ciphertext", summary: [] };
    const signed: AssistantMessage = {
      ...prior,
      content: [
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
        { type: "text", text: "File checked.", textSignature: JSON.stringify({ v: 1, id: "msg_saved", phase: "final_answer" }) },
      ],
    };
    const parameters = {
      type: "object", additionalProperties: false,
      properties: { offset: { type: "integer", minimum: 0, default: 0 }, cursor: { type: ["string", "null"], default: null } },
    };
    const result = await completeWithOpenAiCodexFetch({
      model, fetch: fetchMock,
      options: { apiKey: codexToken(), temperature: 0 },
      context: {
        messages: [
          { role: "user", content: "Read the file.", timestamp: 0 }, foreign,
          { role: "toolResult", toolCallId: "call_legacy", toolName: "Read", content: [{ type: "text", text: output }], isError: false, timestamp: 1 },
          signed, { role: "user", content: "Continue.", timestamp: 2 },
        ],
        tools: [{ name: "Read", description: "Read a file", parameters }],
      },
    });
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(2);
    const request = requests[1]!;
    const input = requestInput(request);
    const call = input.find((item) => item.type === "function_call");
    expect(call).toEqual({ type: "function_call", call_id: "call_legacy", name: "Read", arguments: JSON.stringify(argumentsValue) });
    expect(input).toContainEqual({ type: "function_call_output", call_id: "call_legacy", output });
    expect(input).toContainEqual(reasoning);
    expect(input.find((item) => item.id === "msg_saved")).toMatchObject({ phase: "final_answer", content: [{ type: "output_text", text: "File checked." }] });
    expect(input.find((item) => item.role === "assistant")).not.toHaveProperty("phase");
    expect(request).toMatchObject({
      store: false, temperature: 0,
      tools: [{ type: "function", name: "Read", description: "Read a file", parameters, strict: null }],
    });
  });

  it("streams Codex SSE through the supplied fetch implementation", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return sseResponse(codexTextEvents());
    };

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
        reasoning: "low",
        sessionId: "session-1",
        timeoutMs: 30_000,
      },
    });

    const headers = new Headers(capturedInit?.headers);
    const body = JSON.parse(String(capturedInit?.body));

    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(headers.get("authorization")).toBe(`Bearer ${codexToken("acct-123")}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("session-id")).toBe("session-1");
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      stream: true,
      store: false,
      instructions: "Reply briefly.",
      prompt_cache_key: "session-1",
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("uses an OAuth account id supplied outside the access token", async () => {
    let capturedInit: RequestInit | undefined;
    const accessToken = bareCodexToken();
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return sseResponse(codexTextEvents());
    };

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: accessToken,
        openAiCodexAccountId: "acct-from-metadata",
      },
    });

    const headers = new Headers(capturedInit?.headers);

    expect(result.stopReason).toBe("stop");
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-from-metadata");
  });

  it("handles CRLF-delimited Codex SSE frames", async () => {
    const fetchMock: typeof fetch = async () => sseResponse(codexTextEvents(), "\r\n\r\n");

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
  });

  it("emits an error instead of done for terminal failed Codex responses", async () => {
    const fetchMock: typeof fetch = async () => sseResponse([
      {
        type: "response.created",
        response: { id: "resp_failed" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_failed",
          model: "gpt-5.4-mini",
          status: "failed",
          error: {
            code: "server_error",
            message: "Codex failed",
          },
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            total_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ]);

    const stream = streamWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
      },
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const result = await stream.result();

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("OpenAI Codex returned an error stop reason");
  });

  it("includes non-secret response diagnostics on HTML challenge errors", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("<html><body>Unable to load site</body></html>", {
        status: 403,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "ray-blocked",
          "x-request-id": "req-blocked",
        },
      });

    const result = await streamWithOpenAiCodexFetch({
      model: codexModel(),
      context: { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
      fetch: fetchMock,
      options: {
        apiKey: codexToken(),
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("HTTP 403");
    expect(result.errorMessage).toContain("cf-ray=ray-blocked");
    expect(result.errorMessage).toContain("<html>");
  });
});
