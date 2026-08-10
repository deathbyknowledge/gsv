import {
  createModels,
  type Context,
} from "@earendil-works/pi-ai";
import {
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  type ManagedInferenceGeneration,
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

describe("GSV inference provider", () => {
  it("registers only when its service binding is present", () => {
    const service: ManagedInferenceService = {
      generate: vi.fn(),
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

  it("aborts a generation that arrives after request cancellation", async () => {
    let releaseGenerate: (generation: ManagedInferenceGeneration) => void = () => {};
    let markGenerateStarted: () => void = () => {};
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    const generate = vi.fn<ManagedInferenceService["generate"]>(() => new Promise((resolve) => {
      releaseGenerate = resolve;
      markGenerateStarted();
    }));
    const controller = new AbortController();
    const stream = providerStream({ generate }, controller.signal);
    const completion = stream.result();

    await generateStarted;
    controller.abort(new Error("test cancellation"));
    const result = vi.fn<ManagedInferenceGeneration["result"]>();
    const abort = vi.fn(async () => {});
    releaseGenerate({ result, abort });

    await expect(completion).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "GSV inference cancelled",
    });
    expect(result).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts the active result", async () => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    let rejectResult: (reason?: unknown) => void = () => {};
    const result = vi.fn<ManagedInferenceGeneration["result"]>(() => new Promise(
      (_resolve, reject) => {
        rejectResult = reject;
        markStarted();
      },
    ));
    const abort = vi.fn(async () => rejectResult(reason));
    const generate = vi.fn<ManagedInferenceService["generate"]>(async () => ({
      result,
      abort,
    }));

    const stream = providerStream({ generate }, controller.signal);
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
