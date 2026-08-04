import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_INFERENCE_PRODUCT_MODEL,
  type ManagedInferenceRequest,
  type ManagedInferenceService,
} from "@humansandmachines/gsv/protocol";
import {
  managedInferenceFromEnv,
  managedLogicalRequestId,
  streamManagedInference,
} from "./managed";

describe("managed inference Gateway transport", () => {
  it("decodes split NDJSON events and preserves only the GSV product identity", async () => {
    const done = event({
      type: "done",
      reason: "stop",
      message: assistantMessage("managed pong"),
    });
    const bytes = new TextEncoder().encode(done);
    const service = fakeService(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    })));

    const result = await streamManagedInference(service, request()).result();

    expect(result).toMatchObject({
      provider: "gsv",
      model: MANAGED_INFERENCE_PRODUCT_MODEL,
      content: [{ type: "text", text: "managed pong" }],
      stopReason: "stop",
    });
    expect(service.run).toHaveBeenCalledWith(request());
  });

  it("propagates caller cancellation to the inference owner", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const service = fakeService(
      async () => new Response(new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
      })),
      async () => {
        bodyController?.enqueue(new TextEncoder().encode(event({
          type: "error",
          reason: "aborted",
          error: { ...assistantMessage(""), stopReason: "aborted" },
        })));
        bodyController?.close();
        return { aborted: true };
      },
    );
    const controller = new AbortController();
    const result = streamManagedInference(service, request(), controller.signal).result();
    await vi.waitFor(() => expect(bodyController).toBeDefined());

    controller.abort(new Error("cancelled"));

    await expect(result).resolves.toMatchObject({ stopReason: "aborted" });
    expect(service.abort).toHaveBeenCalledWith({
      installationId: "inst_test",
      logicalRequestId: "request_test",
    });
  });

  it("turns budget admission failures into stable model errors", async () => {
    const service = fakeService(async () => Response.json({
      error: "Managed inference monthly budget reached",
      code: "monthly_budget",
    }, { status: 429 }));

    await expect(streamManagedInference(service, request()).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Managed inference monthly budget reached",
    });
  });

  it("fails malformed cross-worker events closed", async () => {
    const service = fakeService(async () => new Response(event({
      type: "done",
      reason: "stop",
      message: { ...assistantMessage("bad"), provider: "upstream" },
    })));

    await expect(streamManagedInference(service, request()).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Managed inference temporarily unavailable",
    });
  });

  it("rejects and cancels a body that emits data after completion", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          event({ type: "done", reason: "stop", message: assistantMessage("bad") }),
          event({ type: "done", reason: "stop", message: assistantMessage("later") }),
        ].join("")));
      },
      cancel,
    });
    const service = fakeService(async () => new Response(body));

    await expect(streamManagedInference(service, request()).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Managed inference temporarily unavailable",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enables the binding only when the Gateway is managed", async () => {
    const service = fakeService(async () => new Response());
    expect(managedInferenceFromEnv({ MANAGED_INFERENCE: service } as unknown as Env))
      .toBeUndefined();
    expect(managedInferenceFromEnv({
      INSTALLATION_DIRECTORY: {},
      MANAGED_INFERENCE: service,
    } as unknown as Env)).toBe(service);

    const first = await managedLogicalRequestId(["inst_test", "run_test"]);
    const replay = await managedLogicalRequestId(["inst_test", "run_test"]);
    const sibling = await managedLogicalRequestId(["inst_other", "run_test"]);
    expect(replay).toBe(first);
    expect(sibling).not.toBe(first);
    expect(first).toMatch(/^managed-inference:[a-f0-9]{64}$/);
  });
});

function fakeService(
  run: ManagedInferenceService["run"],
  abort: ManagedInferenceService["abort"] = async () => ({ aborted: false }),
): ManagedInferenceService & {
  run: ReturnType<typeof vi.fn<ManagedInferenceService["run"]>>;
  abort: ReturnType<typeof vi.fn<ManagedInferenceService["abort"]>>;
} {
  return {
    run: vi.fn(run),
    abort: vi.fn(abort),
  };
}

function request(): ManagedInferenceRequest {
  return {
    version: 1,
    installationId: "inst_test",
    logicalRequestId: "request_test",
    actor: { localUid: 1000, processId: "proc_test", runId: "run_test" },
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    capability: "text",
    messages: [{ role: "user", content: "ping" }],
    maxOutputTokens: 128,
    reasoning: "high",
    timeoutMs: 1_000,
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: text ? [{ type: "text" as const, text }] : [],
    api: "gsv-managed",
    provider: "gsv",
    model: MANAGED_INFERENCE_PRODUCT_MODEL,
    usage: {
      input: 10,
      output: text ? 5 : 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: text ? 15 : 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function event(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
