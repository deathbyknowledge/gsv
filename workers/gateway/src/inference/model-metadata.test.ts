import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceExecutionService, InferenceModelMetadata } from "@humansandmachines/gsv/services/inference-execution";
import { telemetryRecordSchema } from "@humansandmachines/gsv/telemetry";
import { ModelMetadataResolver } from "./model-metadata";

function fixture() {
  const resolveModel = vi.fn<InferenceExecutionService["resolveModel"]>(async (provider, model) => ({
    provider, model, contextWindowTokens: 262_144,
  }));
  const env = { GSV_TELEMETRY_ENABLED: true, INFERENCE_EXECUTION: {
    resolveModel, getExecutor: vi.fn(async () => { throw new Error("unexpected admission"); }),
  } };
  return { env, resolveModel, resolver: new ModelMetadataResolver(env, "inst_metadata") };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Kernel model metadata", () => {
  it("refreshes successful metadata after one minute without extending expiry on reads", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { resolver, resolveModel, env } = fixture();
    expect(await resolver.resolve("gsv", "default", 180_000)).toBe(262_144);
    resolveModel.mockResolvedValue({ provider: "gsv", model: "default", contextWindowTokens: 131_072 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await resolver.resolve("gsv", "default", 180_000)).toBe(262_144);
    expect(resolveModel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await resolver.resolve("gsv", "default", 180_000)).toBe(131_072);
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(env.INFERENCE_EXECUTION.getExecutor).not.toHaveBeenCalled();
    const records = log.mock.calls.map(([record]) => telemetryRecordSchema.parse(record));
    expect(records.map((record) => record.event.properties)).toEqual([
      expect.objectContaining({ cache: "miss", outcome: "ok" }),
      expect.objectContaining({ cache: "hit", outcome: "ok" }),
      expect.objectContaining({ cache: "miss", outcome: "ok" }),
    ]);
    const first = records[0].event;
    expect(first.name).toBe("inference.metadata.finished");
    if (first.name !== "inference.metadata.finished") throw new Error("unexpected telemetry event");
    expect(resolveModel.mock.calls[0][2]).toEqual({ installationId: "inst_metadata", lookupId: first.properties.lookupId });
  });

  it("separates providers, model names and Kernels and bounds cache growth", async () => {
    const { resolver, resolveModel, env } = fixture();
    env.GSV_TELEMETRY_ENABLED = false;
    for (const [provider, model] of [["a:b", "c"], ["a", "b:c"], ["a", "other"]]) {
      await resolver.resolve(provider, model, 180_000);
    }
    await new ModelMetadataResolver(env, "inst_other").resolve("a:b", "c", 180_000);
    expect(resolveModel).toHaveBeenCalledTimes(4);
    for (let index = 0; index < 64; index++) await resolver.resolve("gsv", String(index), 180_000);
    await resolver.resolve("gsv", "63", 180_000);
    expect(resolveModel).toHaveBeenCalledTimes(68);
    await resolver.resolve("a:b", "c", 180_000);
    expect(resolveModel).toHaveBeenCalledTimes(69);
  });

  it("does not cache failures or export exception text or model names", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { resolver, resolveModel } = fixture();
    resolveModel.mockRejectedValueOnce(new Error("private diagnostic detail"));
    await expect(resolver.resolve("custom", "private-model", 180_000)).rejects.toThrow("private diagnostic detail");
    await expect(resolver.resolve("custom", "private-model", 180_000)).resolves.toBe(262_144);
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([record]) => record.event.properties.outcome)).toEqual(["error", "ok"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("allows a lookup to finish between five and ten seconds", async () => {
    vi.useFakeTimers();
    const { resolver, resolveModel, env } = fixture();
    env.GSV_TELEMETRY_ENABLED = false;
    resolveModel.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({
      provider: "gsv", model: "default", contextWindowTokens: 262_144,
    }), 9_000)));
    const result = resolver.resolve("gsv", "default", 180_000);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(result).resolves.toBe(262_144);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache a late RPC result after timing out and disposing it", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { resolver, resolveModel } = fixture();
    let finish!: (metadata: InferenceModelMetadata) => void;
    const dispose = vi.fn();
    resolveModel.mockImplementationOnce(() => Object.assign(new Promise<InferenceModelMetadata>((resolve) => {
      finish = resolve;
    }), { [Symbol.dispose]: dispose }));
    const failed = expect(resolver.resolve("gsv", "default", 180_000)).rejects.toThrow("timed out after 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(dispose).toHaveBeenCalledOnce();
    finish({ provider: "gsv", model: "default", contextWindowTokens: 123 });
    await Promise.resolve();
    await expect(resolver.resolve("gsv", "default", 180_000)).resolves.toBe(262_144);
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0].event.properties).toMatchObject({ outcome: "timeout", durationMs: 10_000, cache: "miss" });
  });
});
