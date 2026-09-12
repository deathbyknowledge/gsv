import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  decodeManagedInferenceStream,
  encodeManagedInferenceStreamEvent,
  GSV_INFERENCE_PRODUCT_MODEL,
} from "@humansandmachines/gsv/protocol";
import type {
  ManagedInferenceModelRouting,
  ManagedInferenceRequest,
  ManagedInferenceRouting,
} from "@humansandmachines/gsv/protocol";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkersAiGeneration,
  toInferenceStreamEvent,
} from "../src/workers-ai";

interface TestObject { [key: string]: TestValue; }
type TestValue = string | number | boolean | null | TestObject | TestValue[];

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

const SECOND_MODEL: ManagedInferenceModelRouting = {
  modelId: "@cf/test/second",
  displayName: "Second test model",
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  reasoning: true,
  inputNanoUsdPerToken: 150,
  outputNanoUsdPerToken: 500,
  cacheReadNanoUsdPerToken: 30,
  cacheWriteNanoUsdPerToken: 0,
};

const FIRST_MODEL: ManagedInferenceModelRouting = {
  modelId: "@cf/test/first",
  displayName: "First test model",
  contextWindow: 1_310_720,
  maxOutputTokens: 32_768,
  reasoning: true,
  inputNanoUsdPerToken: 440,
  outputNanoUsdPerToken: 1_320,
  cacheReadNanoUsdPerToken: 14,
  cacheWriteNanoUsdPerToken: 0,
};

const ROUTING: ManagedInferenceRouting = {
  version: 2,
  models: [SECOND_MODEL],
  updatedAt: 1,
};

const FALLBACK_ROUTING: ManagedInferenceRouting = {
  ...ROUTING,
  models: [FIRST_MODEL, SECOND_MODEL],
};

function testBinding(
  fetch: NonNullable<AiBinding["fetch"]>,
) {
  return { binding: { aiGatewayLogId: null, fetch } satisfies AiBinding };
}

function completionResponse(
  model = SECOND_MODEL.modelId,
  id = "gen_test",
): Response {
  return new Response([
    sse({
      id,
      model,
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
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared Workers AI inference", () => {

  it("requires the native AI binding fetch capability before dispatch", () => {
    expect(() => createWorkersAiGeneration(REQUEST, { aiGatewayLogId: null }))
      .toThrow("the AI binding does not expose fetch()");
  });

  it("uses the binding route while returning the stable GSV product model", async () => {
    const run = vi.fn<NonNullable<AiBinding["fetch"]>>(async () => completionResponse());
    const { binding } = testBinding(run);
    const generation = createWorkersAiGeneration(REQUEST, binding);
    const [first, second] = await Promise.all([
      generation.result(ROUTING),
      generation.result(ROUTING),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    const request = new Request(...run.mock.calls[0]);
    expect(request.url).toBe("https://workers-binding.ai/ai-gateway/gateways/default/compat/chat/completions");
    expect(request.method).toBe("POST");
    expect(request.headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(JSON.parse(request.headers.get("cf-aig-metadata")!)).toEqual({
      "gsv.installation_id": REQUEST.installationId,
      "gsv.request_id": REQUEST.logicalRequestId,
      "gsv.attempt_id": expect.any(String),
    });
    expect(request.headers.get("x-client-request-id")).toBe("pid_test");
    expect(request.headers.get("x-session-affinity")).toBe("pid_test");
    expect(request.headers.get("cf-aig-authorization")).toBe(`Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("x-api-key")).toBe(false);
    const query: unknown = await request.json();
    expect(query).toMatchObject({
      model: "workers-ai/@cf/test/second",
      max_tokens: 32,
      stream: true,
    });
    expect(JSON.stringify(query)).not.toContain(REQUEST.installationId);
    expect(JSON.stringify(query)).not.toContain(REQUEST.logicalRequestId);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      api: "gsv-inference",
      provider: "gsv",
      model: "gsv/default",
      responseModel: "@cf/test/second",
      responseId: "gen_test",
      usage: { input: 2, output: 1, totalTokens: 3 },
      stopReason: "stop",
    });
  });

  it("captures content-free diagnostics for provider HTTP failures", async () => {
    const run = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "provider-specific private detail" },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }));
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );
    const result = await generation.result(ROUTING);

    expect(result.stopReason).toBe("error");
    expect(generation.accepted()).toBe(false);
    expect(generation.failure(result.errorMessage)).toEqual({
      kind: "rate_limited",
      stage: "provider",
      retryable: true,
      providerStatusCode: 429,
    });
    expect(JSON.stringify(generation.failure(result.errorMessage)))
      .not.toContain("private detail");
  });

  it("falls back after a retryable failure before output is exposed", async () => {
    const run = vi.fn<NonNullable<AiBinding["fetch"]>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "rate limit reached" },
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(completionResponse(
        SECOND_MODEL.modelId,
        "gen_fallback",
      ));
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );
    const events: AssistantMessageEvent[] = [];

    for await (const event of generation.stream(FALLBACK_ROUTING)) {
      events.push(event);
    }

    expect(run).toHaveBeenCalledTimes(2);
    const metadata = run.mock.calls.map((args) => JSON.parse(new Request(...args).headers.get("cf-aig-metadata")!));
    expect(metadata).toEqual([0, 1].map(() => ({
      "gsv.installation_id": REQUEST.installationId,
      "gsv.request_id": REQUEST.logicalRequestId,
      "gsv.attempt_id": expect.any(String),
    })));
    expect(metadata[0]["gsv.attempt_id"]).not.toBe(metadata[1]["gsv.attempt_id"]);
    expect(await Promise.all(run.mock.calls.map(async (args) => new Request(...args).json()))).toMatchObject([
      { model: `workers-ai/${FIRST_MODEL.modelId}` },
      { model: `workers-ai/${SECOND_MODEL.modelId}` },
    ]);
    expect(events[0]).toMatchObject({
      type: "start",
      partial: {
        content: [],
        model: `workers-ai/${SECOND_MODEL.modelId}`,
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { responseModel: SECOND_MODEL.modelId },
    });
    expect(JSON.stringify(events)).not.toContain(FIRST_MODEL.modelId);
    expect(generation.attempts()).toMatchObject([{
      model: { modelId: FIRST_MODEL.modelId },
      accepted: false,
      failure: {
        kind: "rate_limited",
        retryable: true,
        providerStatusCode: 429,
      },
    }, {
      model: { modelId: SECOND_MODEL.modelId },
      accepted: true,
      result: { stopReason: "stop" },
    }]);
  });

  it("does not fall back after provider output has started", async () => {
    const run = vi.fn(async () => new Response([
      sse({
        id: "gen_partial",
        model: FIRST_MODEL.modelId,
        choices: [{ index: 0, delta: { content: "partial" } }],
      }),
      "data: not-json\n\n",
    ].join(""), {
      headers: { "content-type": "text/event-stream" },
    }));
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );
    const events: AssistantMessageEvent[] = [];

    for await (const event of generation.stream(FALLBACK_ROUTING)) {
      events.push(event);
    }

    expect(run).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not fall back after a non-retryable provider rejection", async () => {
    const run = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "invalid request" },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );

    const result = await generation.result(FALLBACK_ROUTING);

    expect(result.stopReason).toBe("error");
    expect(run).toHaveBeenCalledTimes(1);
    expect(generation.failure(result.errorMessage)).toMatchObject({
      kind: "invalid_request",
      retryable: false,
      providerStatusCode: 400,
    });
  });

  it("classifies binding failures without an HTTP response as network errors", async () => {
    const run = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );
    const result = await generation.result(ROUTING);

    expect(result.stopReason).toBe("error");
    expect(generation.failure(result.errorMessage)).toEqual({
      kind: "network",
      stage: "provider",
      retryable: true,
    });
  });

  it("aborts the one owned binding generation", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = vi.fn<NonNullable<AiBinding["fetch"]>>(async (input, options) => {
      markStarted?.();
      const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    const generation = createWorkersAiGeneration(
      REQUEST,
      testBinding(run).binding,
    );
    const resultPromise = generation.result(FALLBACK_ROUTING);

    await started;
    await generation.abort();

    await expect(resultPromise).resolves.toMatchObject({
      provider: "gsv",
      model: "gsv/default",
      stopReason: "aborted",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each<TestObject>([
    { role: "assistant" },
    { content: "" },
    { reasoning_content: "" },
    { tool_calls: [{ index: 0, type: "function", function: { name: "", arguments: "" } }] },
  ])("falls back from an accepted stream containing only metadata %j", async (delta) => {
    const stalled = stalledResponse(sse({
      id: "gen_metadata",
      model: FIRST_MODEL.modelId,
      choices: [{ index: 0, delta }],
    }));
    const run = vi.fn()
      .mockResolvedValueOnce(stalled.response)
      .mockResolvedValueOnce(completionResponse(SECOND_MODEL.modelId, "gen_recovered"));
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const events: AssistantMessageEvent[] = [];

    for await (const event of generation.stream(FALLBACK_ROUTING)) events.push(event);

    expect(run).toHaveBeenCalledTimes(2);
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done", message: { responseId: "gen_recovered" },
    });
    expect(JSON.stringify(events)).not.toContain("gen_metadata");
    expect(generation.attempts()).toMatchObject([{
      accepted: true,
      outputExposed: false,
      timeoutKind: "first_output",
      firstActivityAt: expect.any(Number),
      lastActivityAt: expect.any(Number),
      failure: { kind: "timeout", stage: "stream", retryable: true },
    }, { accepted: true, result: { stopReason: "stop" } }]);
  });

  it.each([1, 2, 3])("bounds %i stalled candidates by one overall deadline", async (count) => {
    const stalled = Array.from({ length: count }, () => stalledResponse());
    const run = vi.fn(async () => stalled[run.mock.calls.length - 1].response);
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const routing = { ...ROUTING, models: Array.from({ length: count }, () => SECOND_MODEL) };
    const startedAt = Date.now();

    await expect(generation.result(routing)).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Managed inference exceeded its 1000 ms deadline",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(run).toHaveBeenCalledTimes(count);
    expect(generation.attempts().map((attempt) => attempt.timeoutKind)).toEqual([
      ...Array.from({ length: count - 1 }, () => "first_output"), "generation",
    ]);
    for (const body of stalled) expect(body.cancel).toHaveBeenCalledOnce();
  });

  it.each<TestObject>([
    { content: "partial" },
    { reasoning_content: "partial reasoning" },
    { tool_calls: [{ index: 0, id: "call_partial", type: "function", function: { name: "read", arguments: '{"path":' } }] },
  ])("keeps the overall deadline without fallback after exposed output %j", async (delta) => {
    const stalled = stalledResponse(sse({
      id: "gen_partial",
      model: FIRST_MODEL.modelId,
      choices: [{ index: 0, delta }],
    }));
    const run = vi.fn(async () => stalled.response);
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const events: AssistantMessageEvent[] = [];
    const startedAt = Date.now();

    for await (const event of generation.stream(FALLBACK_ROUTING)) events.push(event);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(run).toHaveBeenCalledOnce();
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type.endsWith("_delta"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
    expect(generation.attempts()[0]).toMatchObject({
      outputExposed: true, timeoutKind: "generation", failure: { kind: "timeout" },
    });
  });

  it("cancels an accepted stalled stream immediately without fallback", async () => {
    const stalled = stalledResponse();
    const run = vi.fn(async () => stalled.response);
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const result = generation.result(FALLBACK_ROUTING);
    await vi.waitFor(() => expect(generation.accepted()).toBe(true));

    await generation.abort();
    await generation.abort("timeout");

    await expect(result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(run).toHaveBeenCalledOnce();
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(generation.attempts()[0].timeoutKind).toBeUndefined();
  });

  it("cancels late accepted bodies without exposing their output", async () => {
    let respond: (response: Response) => void = () => {};
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }))
      .mockResolvedValueOnce(completionResponse(SECOND_MODEL.modelId, "gen_fallback"));
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const result = await generation.result(FALLBACK_ROUTING);
    const late = stalledResponse(sse({ choices: [{ index: 0, delta: { content: "late" } }] }));

    respond(late.response);

    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce());
    expect(result).toMatchObject({ stopReason: "stop", responseId: "gen_fallback" });
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not start a provider after the caller deadline has expired", async () => {
    const run = vi.fn(async () => completionResponse());
    const generation = createWorkersAiGeneration({
      ...REQUEST, deadlineAt: Date.now() - 1,
    }, testBinding(run).binding);

    await expect(generation.result(FALLBACK_ROUTING)).resolves.toMatchObject({ stopReason: "error" });
    expect(generation.failure()).toMatchObject({ kind: "timeout" });
    expect(run).not.toHaveBeenCalled();
  });

  it("clamps a later caller deadline to the service timeout", async () => {
    const run = vi.fn(async () => stalledResponse().response);
    const generation = createWorkersAiGeneration({
      ...REQUEST, deadlineAt: Date.now() + 60_000,
    }, testBinding(run).binding);
    const startedAt = Date.now();

    await expect(generation.result(ROUTING)).resolves.toMatchObject({ stopReason: "error" });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(generation.attempts()[0].timeoutKind).toBe("generation");
  });

  it("recognizes expiry before a consumer-close abort beats the timer callback", async () => {
    const startedAt = Date.now();
    const run = vi.fn(async () => completionResponse());
    const generation = createWorkersAiGeneration(REQUEST, testBinding(run).binding);
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt + REQUEST.timeoutMs + 1);
    try {
      await generation.abort();
      await expect(generation.result(ROUTING)).resolves.toMatchObject({ stopReason: "error" });
      expect(generation.failure()).toMatchObject({ kind: "timeout" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("releases the source reader when provider cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const generation = createWorkersAiGeneration(REQUEST, testBinding(
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    ).binding);
    const result = generation.result(FALLBACK_ROUTING);
    await vi.waitFor(() => expect(generation.accepted()).toBe(true));

    await generation.abort();

    await expect(result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("strips provider-only scratch fields from streamed tool calls", async () => {
    const toolCall = {
      type: "toolCall",
      id: "call_test",
      name: "read",
      arguments: { path: "/tmp/test" },
      partialArgs: '{"path":"/tmp/test"}',
      streamIndex: 0,
    } satisfies ToolCall & { partialArgs: string; streamIndex: number };
    const partial = {
      role: "assistant",
      content: [toolCall],
      api: "openai-completions",
      provider: "cloudflare-ai-gateway",
      model: "workers-ai/@cf/test/second",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: 1,
    } satisfies AssistantMessage;
    const sourceEvents = [{
      type: "toolcall_start",
      contentIndex: 0,
      partial,
    }, {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"/tmp/test"}',
      partial,
    }] satisfies AssistantMessageEvent[];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of sourceEvents) {
          controller.enqueue(encodeManagedInferenceStreamEvent(
            toInferenceStreamEvent(event),
          ));
        }
        controller.close();
      },
    });
    const decoded = [];

    for await (const event of decodeManagedInferenceStream(body)) {
      decoded.push(event);
    }

    const wireToolCall = {
      type: "toolCall",
      id: "call_test",
      name: "read",
      arguments: { path: "/tmp/test" },
    };
    expect(decoded).toEqual([{
      type: "toolcall_start",
      contentIndex: 0,
      toolCall: wireToolCall,
    }, {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"/tmp/test"}',
      toolCall: wireToolCall,
    }]);
  });

  it("rejects an unsupported product model before using the binding", () => {
    // SAFETY: This fixture deliberately violates the model literal to exercise runtime rejection.
    const input = { ...REQUEST, model: "gsv/unknown" as typeof REQUEST.model };
    const run = vi.fn(async () => completionResponse());

    expect(() => createWorkersAiGeneration(
      input,
      testBinding(run).binding,
    )).toThrow("Unsupported managed inference model: gsv/unknown");
    expect(run).not.toHaveBeenCalled();
  });
});

function sse(payload: TestObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function stalledResponse(prefix?: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(new TextEncoder().encode(prefix));
    },
    cancel,
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    cancel,
  };
}
