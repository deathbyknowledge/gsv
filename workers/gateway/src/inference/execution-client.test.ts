import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeInferenceExecutionStreamEvent, type AiAssistantMessage, type AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import { createGenerationService } from "./execution-client";

const config: AiConfigResult = {
  executor: { kind: "kernel" }, provider: "openai-codex", model: "gpt-6-astra",
  apiKey: "selected-credential", reasoning: "high", maxTokens: 1000,
  contextWindowTokens: 100000, contextWindowSource: "model", capabilities: [],
  maxContextBytes: 32000, generationTimeoutMs: 1000,
};
const attribution = { installationId: "space-a", logicalRequestId: "generation-a", actor: { localUid: 1000, pid: "process-a", runId: "run-a" } };
const message: AiAssistantMessage = {
  role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra",
  content: [{ type: "text", text: "Hello" }], stopReason: "stop", timestamp: 1,
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  usageCostSource: "model-pricing",
};
function fixture() {
  const target = {
    generate: vi.fn(async () => message),
    generateStream: vi.fn(async () => new Response(encodeInferenceExecutionStreamEvent({ type: "done", reason: "stop", message })).body!),
    abort: vi.fn(async () => {}), media: vi.fn(), [Symbol.dispose]: vi.fn(),
  };
  const getExecutor = vi.fn(async (_space: string): Promise<InferenceExecutor> => target);
  // SAFETY: These tests exercise only the required inference binding.
  const env = { INFERENCE_EXECUTION: { getExecutor } } as GatewayEnv;
  const request = { config, context: { systemPrompt: "system", messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] }, attribution };
  return { target, getExecutor, service: createGenerationService(env), request };
}
afterEach(() => vi.useRealTimers());

describe("gateway inference execution boundary", () => {
  it("preserves model identity and ordered generic events without forwarding Kernel configuration", async () => {
    const { target, getExecutor, service, request } = fixture();
    target.generateStream.mockImplementation(async () => new Response([
      encodeInferenceExecutionStreamEvent({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }),
      encodeInferenceExecutionStreamEvent({ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } }),
      encodeInferenceExecutionStreamEvent({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
      encodeInferenceExecutionStreamEvent({ type: "done", reason: "stop", message }),
    ].map((part) => new TextDecoder().decode(part)).join("")).body!);
    const output = service.stream(request);
    const events = [];
    for await (const event of output) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(await output.result()).toEqual(message);
    expect(getExecutor).toHaveBeenCalledWith("space-a");
    const input = target.generateStream.mock.calls[0]?.[0];
    expect(input).toMatchObject({ ...attribution, connection: { apiKey: "selected-credential" }, timeoutMs: 1000 });
    expect(input?.connection).not.toHaveProperty("capabilities");
    expect(input?.connection).not.toHaveProperty("executor");
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("bounds executor acquisition and disposes a late result without starting generation", async () => {
    vi.useFakeTimers();
    const { target, getExecutor, service, request } = fixture();
    let resolve!: (target: InferenceExecutor) => void;
    getExecutor.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = service.generate(request);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({ stopReason: "error", errorMessage: "Model generation timed out after 1000ms" });
    resolve(target);
    await Promise.resolve();
    expect(target.generate).not.toHaveBeenCalled();
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("cancels an idle stream and sends one abort to the owning executor", async () => {
    const { target, service, request } = fixture();
    const cancel = vi.fn();
    target.generateStream.mockResolvedValue(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const stream = service.stream({ ...request, signal: controller.signal });
    await vi.waitFor(() => expect(target.generateStream).toHaveBeenCalledOnce());
    controller.abort(new Error("user stopped run"));
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: "user stopped run" });
    expect(target.abort).toHaveBeenCalledExactlyOnceWith("generation-a", "cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports truncated provider output as an error instead of accepting a silent success", async () => {
    const { target, service, request } = fixture();
    target.generateStream.mockResolvedValue(new Response(encodeInferenceExecutionStreamEvent({ type: "start", partial: { ...message, stopReason: "pending" } })).body!);
    const stream = service.stream(request);
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("terminal") });
    expect(target.abort).toHaveBeenCalledOnce();
  });
});
