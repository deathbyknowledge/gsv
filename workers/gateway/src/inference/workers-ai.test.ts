import { env } from "cloudflare:workers";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKERS_AI_MODEL,
  extractWorkersAiContextWindow,
  hasWorkersAiModelPricing,
  prepareWorkersAiGatewayPayload,
  resolveWorkersAiModelMetadata,
  workersAiBindingFetch,
  workersAiProvider,
} from "./workers-ai";

type TestAi = {
  aiGatewayLogId: string | null;
  fetch: typeof fetch;
  models(): Promise<never[]>;
};

function installAi(ai: TestAi): void {
  // SAFETY: The Workers test environment permits replacing bindings with fixtures.
  (env as typeof env & { AI: TestAi }).AI = ai;
}

function completionStream(): Response {
  const chunks = [
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      model: DEFAULT_WORKERS_AI_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      model: DEFAULT_WORKERS_AI_MODEL,
      choices: [{ index: 0, delta: { content: " from Workers AI" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      model: DEFAULT_WORKERS_AI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
    + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Workers AI provider", () => {
  it("uses GLM-5.3-Flash as the priced default model", () => {
    expect(DEFAULT_WORKERS_AI_MODEL).toBe("@cf/zai-org/glm-5.3-flash");
    expect(resolveWorkersAiModelMetadata(DEFAULT_WORKERS_AI_MODEL)).toMatchObject({
      api: "openai-completions",
      provider: "workers-ai",
      reasoning: true,
      cost: {
        input: 0.15,
        output: 0.5,
        cacheRead: 0.03,
      },
    });
    expect(hasWorkersAiModelPricing(DEFAULT_WORKERS_AI_MODEL)).toBe(true);
  });

  it("routes pi-ai's OpenAI-compatible request through the binding", async () => {
    const bindingFetch = vi.fn<typeof fetch>(async () => completionStream());
    installAi({
      aiGatewayLogId: null,
      fetch: bindingFetch,
      models: vi.fn(async () => []),
    });

    const models = createModels();
    models.setProvider(workersAiProvider);
    const model = models.getModel("workers-ai", DEFAULT_WORKERS_AI_MODEL);
    expect(model).toBeDefined();
    if (!model) return;

    const context: Context = {
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
      tools: [{ name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    };
    const result = await models.completeSimple(model, context, {
      fetch: workersAiBindingFetch,
      maxTokens: 64,
      reasoning: "high",
      onPayload: prepareWorkersAiGatewayPayload,
      sessionId: "process_test",
    });

    expect(result).toMatchObject({
      api: "openai-completions",
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_MODEL,
      content: [{ type: "text", text: "hello from Workers AI" }],
      stopReason: "stop",
      usage: { input: 11, output: 4, totalTokens: 15 },
    });
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    const [input, options] = bindingFetch.mock.calls[0]!;
    const request = new Request(input, options);
    expect(request.url).toBe("https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions");
    const payload = await request.json();
    expect(payload).toMatchObject({
      model: `workers-ai/${DEFAULT_WORKERS_AI_MODEL}`,
      max_tokens: 64,
      stream: true,
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say hello" },
      ],
      tools: [{ type: "function", function: { name: "Read" } }],
    });
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("tools.0.function.strict");
    expect(request.headers.get("cf-aig-collect-log")).toBe("false");
    expect(request.headers.get("cf-aig-authorization")).toBe("Bearer cloudflare-gateway-binding");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("x-api-key")).toBe(false);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("prepareWorkersAiGatewayPayload", () => {
  it("adds the Workers AI provider segment without changing the public model id", () => {
    const model = resolveWorkersAiModelMetadata(DEFAULT_WORKERS_AI_MODEL);
    expect(model).not.toBeNull();
    if (!model) return;

    expect(prepareWorkersAiGatewayPayload({ model: model.id }, model)).toEqual({
      model: `workers-ai/${model.id}`,
    });
    expect(model.id).toBe(DEFAULT_WORKERS_AI_MODEL);
  });

  it("rejects a non-object provider payload", () => {
    const model = resolveWorkersAiModelMetadata(DEFAULT_WORKERS_AI_MODEL);
    expect(model).not.toBeNull();
    if (!model) return;

    expect(() => prepareWorkersAiGatewayPayload(null, model)).toThrow(
      "Workers AI generated an invalid request payload",
    );
  });
});

describe("extractWorkersAiContextWindow", () => {
  it("reads model properties before description prose", () => {
    expect(extractWorkersAiContextWindow({
      id: "model",
      description: "A 32k token context window.",
      properties: [{ property_id: "context_window", value: "128K tokens" }],
    })).toBe(128_000);
  });

  it("falls back to the catalog description", () => {
    expect(extractWorkersAiContextWindow({
      id: "model",
      description: "Supports up to 1M tokens for long documents.",
    })).toBe(1_000_000);
  });
});
