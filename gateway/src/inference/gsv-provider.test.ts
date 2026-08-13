import {
  createModels,
  type Context,
} from "@earendil-works/pi-ai";
import {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceResult,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createGsvInferenceProviderFactory,
  gsvInferenceFeaturesFromEnv,
  gsvInferenceProviderFactoryFromEnv,
} from "./gsv-provider";

const ATTRIBUTION = {
  installationId: "inst_test",
  logicalRequestId: "request_test",
  actor: { localUid: 1000, processId: "proc_test", runId: "run_test" },
};

const CONTEXT: Context = {
  messages: [{ role: "user", content: "ping", timestamp: 1 }],
};

const RESULT: ManagedInferenceResult = {
  role: "assistant",
  content: [{ type: "text", text: "pong" }],
  api: "gsv-inference",
  provider: GSV_INFERENCE_PROVIDER,
  model: GSV_INFERENCE_PRODUCT_MODEL,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

describe("GSV inference provider", () => {
  it("registers only when its service binding is present", () => {
    const service: ManagedInferenceService = {
      generate: vi.fn(),
      abort: vi.fn(),
    };

    expect(gsvInferenceProviderFactoryFromEnv({
      MANAGED_INFERENCE: service,
    } as Env)).toMatchObject({ id: "gsv" });
    expect(gsvInferenceFeaturesFromEnv({
      MANAGED_INFERENCE: service,
    } as Env)).toEqual([GSV_INFERENCE_FEATURE]);
    expect(gsvInferenceProviderFactoryFromEnv({} as Env)).toBeUndefined();
    expect(gsvInferenceFeaturesFromEnv({} as Env)).toEqual([]);
  });

  it("aborts a generation that completes after request cancellation", async () => {
    let releaseGenerate: (result: ManagedInferenceResult) => void = () => {};
    let markGenerateStarted: () => void = () => {};
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const generate = vi.fn<ManagedInferenceService["generate"]>(() => new Promise((resolve) => {
      releaseGenerate = resolve;
      markGenerateStarted();
    }));
    const controller = new AbortController();
    const abort = vi.fn(async () => {});
    const stream = providerStream({ generate, abort }, controller.signal);
    const completion = stream.result();

    await generateStarted;
    controller.abort(new Error("test cancellation"));
    releaseGenerate(RESULT);

    await expect(completion).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "GSV inference cancelled",
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({
      version: 1,
      installationId: ATTRIBUTION.installationId,
      logicalRequestId: ATTRIBUTION.logicalRequestId,
    });
  });

  it("aborts the active result", async () => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    let rejectGenerate: (reason?: unknown) => void = () => {};
    const generate = vi.fn<ManagedInferenceService["generate"]>(() => new Promise(
      (_resolve, reject) => {
        rejectGenerate = reject;
        markStarted();
      },
    ));
    const abort = vi.fn(async () => rejectGenerate(reason));

    const stream = providerStream({ generate, abort }, controller.signal);
    await started;
    controller.abort(reason);

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "GSV inference cancelled",
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

function providerStream(
  service: ManagedInferenceService,
  signal: AbortSignal,
) {
  const provider = createGsvInferenceProviderFactory(service).create(ATTRIBUTION);
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel("gsv", GSV_INFERENCE_MODEL)!;
  return models.streamSimple(model, CONTEXT, {
    maxTokens: 128,
    timeoutMs: 1_000,
    signal,
  });
}
