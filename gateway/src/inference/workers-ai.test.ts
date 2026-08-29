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

type GatewayRequest = {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
};

type TestAi = {
  gateway(id: string): {
    run(
      request: GatewayRequest,
      options?: { signal?: AbortSignal },
    ): Promise<Response>;
  };
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
    const run = vi.fn(async () => completionStream());
    const gateway = vi.fn((_id: string) => ({ run }));
    installAi({
      gateway,
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
    };
    const result = await models.completeSimple(model, context, {
      fetch: workersAiBindingFetch,
      maxTokens: 64,
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
    expect(gateway).toHaveBeenCalledWith("default");
    expect(run).toHaveBeenCalledTimes(1);
    const [request, options] = run.mock.calls[0];
    expect(request).toMatchObject({
      provider: "compat",
      endpoint: "chat/completions",
      headers: {
        "cf-aig-collect-log": "false",
      },
      query: {
        model: `workers-ai/${DEFAULT_WORKERS_AI_MODEL}`,
        max_tokens: 64,
        stream: true,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Say hello" },
        ],
      },
    });
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.headers).not.toHaveProperty("cf-aig-authorization");
    expect(request.headers).not.toHaveProperty("x-api-key");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
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
