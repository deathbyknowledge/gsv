import { GSV_INFERENCE_PRODUCT_MODEL } from "@humansandmachines/gsv/protocol";
import type {
  ManagedInferenceRequest,
  ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterGeneration } from "./openrouter";

const REQUEST: ManagedInferenceRequest = {
  version: 1,
  installationId: "inst_test",
  logicalRequestId: "request_test",
  actor: { localUid: 1_000, processId: "pid_test", runId: "run_test" },
  model: GSV_INFERENCE_PRODUCT_MODEL,
  systemPrompt: "Answer directly.",
  messages: [{ role: "user", content: "ping", timestamp: 1 }],
  tools: [{
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  }],
  maxOutputTokens: 32,
  reasoning: "medium",
  timeoutMs: 1_000,
};

const ROUTING: ManagedInferenceRouting = {
  version: 1,
  modelId: "deepseek/deepseek-v4-flash-0731",
  displayName: "DeepSeek: DeepSeek V4 Flash 0731",
  contextWindow: 1_048_576,
  maxOutputTokens: 384_000,
  reasoning: true,
  inputNanoUsdPerToken: 80,
  outputNanoUsdPerToken: 180,
  cacheReadNanoUsdPerToken: 16,
  cacheWriteNanoUsdPerToken: 0,
  provider: {
    allowFallbacks: true,
    requireParameters: true,
    dataCollection: "deny",
    zdr: true,
    order: ["Fireworks"],
    only: ["Fireworks", "DeepInfra"],
    ignore: [],
    quantizations: ["fp16", "bf16", "fp8"],
    sort: "throughput",
    preferredMinThroughput: 30,
    preferredMaxLatency: 2.5,
  },
  updatedAt: 1,
};

describe("OpenRouter managed inference", () => {
  it("uses the operator route while returning the stable GSV product model", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response([
      sse({
        id: "gen_test",
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{ index: 0, delta: { content: "pong" } }],
      }),
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
        },
      }),
      "data: [DONE]\n\n",
    ].join(""), {
      headers: { "content-type": "text/event-stream" },
    }));

    const generation = createOpenRouterGeneration(REQUEST, "test-key", fetchMock);
    const [first, second] = await Promise.all([
      generation.result(ROUTING),
      generation.result(ROUTING),
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    const payload = JSON.parse(
      String((init as RequestInit | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("http-referer")).toBe("https://gsv.space");
    expect(headers.get("x-title")).toBe("GSV");
    expect(payload).toMatchObject({
      model: "deepseek/deepseek-v4-flash-0731",
      max_completion_tokens: 32,
      reasoning: { effort: "high" },
      stream: true,
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        order: ["Fireworks"],
        only: ["Fireworks", "DeepInfra"],
        quantizations: ["fp16", "bf16", "fp8"],
        sort: "throughput",
        preferred_min_throughput: 30,
        preferred_max_latency: 2.5,
      },
    });
    expect(JSON.stringify(payload)).not.toContain(REQUEST.installationId);
    expect(JSON.stringify(payload)).not.toContain(REQUEST.logicalRequestId);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      api: "gsv-inference",
      provider: "gsv",
      model: "gsv/default",
      responseModel: "deepseek/deepseek-v4-flash-0731",
      responseId: "gen_test",
      usage: { input: 2, output: 1, totalTokens: 3 },
      stopReason: "stop",
    });
  });

  it("aborts the one owned upstream generation", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      markStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    const generation = createOpenRouterGeneration(REQUEST, "test-key", fetchMock);
    const resultPromise = generation.result(ROUTING);

    await started;
    await generation.abort();

    await expect(resultPromise).resolves.toMatchObject({
      provider: "gsv",
      model: "gsv/default",
      stopReason: "aborted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before dispatch when its credential is absent", () => {
    expect(() => createOpenRouterGeneration(REQUEST, "  ")).toThrow(
      "Managed inference credential is not configured",
    );
  });
});

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
