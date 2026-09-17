import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiDecideResult } from "@humansandmachines/gsv/protocol";
import type { InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import { executeDecision } from "./decision-client";

const input = {
  installationId: "space-a", logicalRequestId: "decision-a", actor: { localUid: 1000 }, timeoutMs: 100,
  connection: { provider: "typesafe" as const, model: "jev-latest", apiKey: "test-only" },
  input: { state: "context", questions: { keep: { type: "boolean" as const, instructions: "Retain?" } } },
};
const result: AiDecideResult = { provider: "typesafe", model: "jev-latest", answers: { keep: { type: "boolean", probability: 0.9 } }, usage: { inputTokens: 1, outputTokens: 1 } };
function fixture() {
  const target = { decide: vi.fn<InferenceExecutor["decide"]>().mockResolvedValue(result), abort: vi.fn(async () => {}), [Symbol.dispose]: vi.fn() };
  // SAFETY: This fixture exercises only decision RPCs and target disposal.
  const executor = target as unknown as InferenceExecutor;
  const getExecutor = vi.fn(async () => executor);
  // SAFETY: The decision client uses only this service binding.
  const env = { INFERENCE_EXECUTION: { getExecutor } } as unknown as GatewayEnv;
  return { target, executor, getExecutor, env };
}
afterEach(() => vi.useRealTimers());

describe("decision cancellation ownership", () => {
  it("attributes the decision and releases the completed target", async () => {
    const { env, target, getExecutor } = fixture();
    expect(await executeDecision(env, input)).toEqual(result);
    expect(getExecutor).toHaveBeenCalledWith("space-a");
    expect(target.decide).toHaveBeenCalledWith(expect.objectContaining({ ...input, version: 1, deadlineAt: expect.any(Number) }));
    expect(target.abort).not.toHaveBeenCalled();
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("aborts the owning provider exactly once and discards late output", async () => {
    const { env, target } = fixture();
    let complete!: (value: AiDecideResult) => void;
    target.decide.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const pending = executeDecision(env, input, controller.signal);
    const rejected = expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(target.decide).toHaveBeenCalledOnce());
    controller.abort(new Error("stopped"));
    await rejected;
    complete(result);
    expect(target.abort).toHaveBeenCalledExactlyOnceWith("decision-a", "cancelled");
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("releases a late executor without submitting work after the deadline", async () => {
    vi.useFakeTimers();
    const { env, target, executor, getExecutor } = fixture();
    let complete!: (value: InferenceExecutor) => void;
    getExecutor.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const rejected = expect(executeDecision(env, input)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    complete(executor);
    await Promise.resolve();
    expect(target.decide).not.toHaveBeenCalled();
    expect(target[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});
