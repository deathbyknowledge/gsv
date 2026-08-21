import { createModels, type Context } from "@earendil-works/pi-ai";
import {
  encodeManagedInferenceStreamEvent,
  GSV_INFERENCE_FEATURE,
  GSV_INFERENCE_MODEL,
  GSV_INFERENCE_PRODUCT_MODEL,
  GSV_INFERENCE_PROVIDER,
  type ManagedInferenceResult,
  type ManagedInferenceService,
  type ManagedInferenceStreamEvent,
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
      generateStream: vi.fn(),
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

  it("forwards deltas before the managed result completes", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const service = managedService(vi.fn(async () => body));
    const stream = providerStream(service, new AbortController().signal);
    const events = stream[Symbol.asyncIterator]();

    bodyController?.enqueue(encoded({
      type: "start",
      partial: { ...RESULT, content: [], stopReason: "pending" },
    }));
    bodyController?.enqueue(encoded({
      type: "text_start",
      contentIndex: 0,
      content: { type: "text", text: "" },
    }));
    bodyController?.enqueue(encoded({
      type: "text_delta",
      contentIndex: 0,
      delta: "pong",
    }));

    await expect(events.next()).resolves.toMatchObject({
      value: { type: "start" },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "text_start" },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "text_delta", delta: "pong" },
    });

    bodyController?.enqueue(encoded({
      type: "text_end",
      contentIndex: 0,
      content: { type: "text", text: "pong" },
    }));
    bodyController?.enqueue(encoded({ type: "done", reason: "stop", message: RESULT }));
    bodyController?.close();
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
      stopReason: "stop",
    });
    expect(service.generateStream).toHaveBeenCalledOnce();
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("aborts an active byte stream on request cancellation", async () => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generateStream = vi.fn<ManagedInferenceService["generateStream"]>(
      async () => new ReadableStream({
        start() {
          markStarted();
        },
      }),
    );
    const controller = new AbortController();
    const abort = vi.fn(async () => {});
    const stream = providerStream({
      generate: vi.fn(),
      generateStream,
      abort,
    }, controller.signal);
    const completion = stream.result();

    await started;
    controller.abort(new Error("test cancellation"));

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

  it("aborts when cancellation overtakes the stream RPC", async () => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    let releaseStream: (value: ReadableStream<Uint8Array>) => void = () => {};
    const generateStream = vi.fn<ManagedInferenceService["generateStream"]>(
      () => new Promise((resolve) => {
        releaseStream = resolve;
        markStarted();
      }),
    );
    const abort = vi.fn(async () => {});

    const stream = providerStream({
      generate: vi.fn(),
      generateStream,
      abort,
    }, controller.signal);
    await started;
    controller.abort(reason);
    releaseStream(eventStream({ type: "done", reason: "stop", message: RESULT }));

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

function managedService(
  generateStream: ManagedInferenceService["generateStream"],
): ManagedInferenceService {
  return { generate: vi.fn(), generateStream, abort: vi.fn() };
}

function encoded(event: ManagedInferenceStreamEvent): Uint8Array {
  return encodeManagedInferenceStreamEvent(event);
}

function eventStream(
  ...events: ManagedInferenceStreamEvent[]
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoded(event));
      controller.close();
    },
  });
}
