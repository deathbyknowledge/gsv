import {
  decodeInferenceRequest,
  encodeInferenceError,
  encodeInferenceResult,
} from "@humansandmachines/gsv-worker-runtime/inference-transport";
import { describe, expect, it, vi } from "vitest";

import { resolveWorkersAiBinding } from "./service-binding";

type TestAiBinding = {
  run(model: string, input: unknown, options?: Record<string, unknown>): Promise<unknown>;
  models(params?: Record<string, unknown>): Promise<unknown>;
};

describe("provider-neutral Workers AI service binding", () => {
  it("uses the native binding when no inference service is configured", () => {
    const direct = { run: vi.fn() } as unknown as Ai;
    expect(resolveWorkersAiBinding({ AI: direct })).toBe(direct);
  });

  it("transports run options and headers without embedding deployment identity", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const decoded = await decodeInferenceRequest(request);
      expect(decoded).toEqual({
        operation: "run",
        model: "@provider/model",
        input: { prompt: "hello", audio: new Uint8Array([1, 2, 3]) },
        options: {
          headers: [["x-session-affinity", "session"]],
          returnRawResponse: true,
        },
      });
      expect(request.headers.has("authorization")).toBe(false);
      return encodeInferenceResult({ response: "ok" });
    });
    const binding = resolveWorkersAiBinding({
      GSV_INFERENCE: { fetch },
    }) as unknown as TestAiBinding;

    await expect(binding.run("@provider/model", {
      prompt: "hello",
      audio: new Uint8Array([1, 2, 3]),
    }, {
      headers: new Headers({ "x-session-affinity": "session" }),
      returnRawResponse: true,
    })).resolves.toEqual({ response: "ok" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("propagates AbortSignal cancellation through the service request", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn((request: Request): Promise<Response> => {
      observedSignal = request.signal;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    });
    const binding = resolveWorkersAiBinding({ GSV_INFERENCE: { fetch } }) as unknown as TestAiBinding;
    const controller = new AbortController();

    const pending = binding.run("@provider/model", { prompt: "hello" }, {
      signal: controller.signal,
    });
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("preserves streamed, binary, and raw Response results", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event"));
        controller.close();
      },
    });
    const responses = [
      encodeInferenceResult(stream),
      encodeInferenceResult(new Uint8Array([7, 8])),
      encodeInferenceResult(new Response("raw", {
        status: 201,
        headers: { "x-provider": "workers-ai" },
      })),
    ];
    const binding = resolveWorkersAiBinding({
      GSV_INFERENCE: { fetch: vi.fn(async () => responses.shift()!) },
    }) as unknown as TestAiBinding;

    const streamed = await binding.run("@provider/model", {});
    expect(streamed).toBeInstanceOf(ReadableStream);
    await expect(new Response(streamed as ReadableStream).text()).resolves.toBe("event");

    const binary = await binding.run("@provider/model", {});
    expect(binary).toBeInstanceOf(Uint8Array);
    expect([...(binary as Uint8Array)]).toEqual([7, 8]);

    const raw = await binding.run("@provider/model", {});
    expect(raw).toBeInstanceOf(Response);
    expect((raw as Response).status).toBe(201);
    expect((raw as Response).headers.get("x-provider")).toBe("workers-ai");
    await expect((raw as Response).text()).resolves.toBe("raw");
  });

  it("transports model catalog calls and typed service errors", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const decoded = await decodeInferenceRequest(request);
      if (decoded.operation === "models") {
        expect(decoded.params).toEqual({ search: "model", per_page: 25 });
        return encodeInferenceResult([{ id: "@provider/model" }]);
      }
      return encodeInferenceError(new Error("inference denied"), 403);
    });
    const binding = resolveWorkersAiBinding({ GSV_INFERENCE: { fetch } }) as unknown as TestAiBinding;

    await expect(binding.models({ search: "model", per_page: 25 }))
      .resolves.toEqual([{ id: "@provider/model" }]);
    await expect(binding.run("@provider/model", {})).rejects.toMatchObject({
      message: "inference denied",
      status: 403,
    });
  });

  it("fails closed when an explicitly configured service is malformed", () => {
    const direct = { run: vi.fn() } as unknown as Ai;
    expect(() => resolveWorkersAiBinding({ AI: direct, GSV_INFERENCE: null }))
      .toThrow("GSV_INFERENCE service binding is invalid");
    expect(direct.run).not.toHaveBeenCalled();
  });
});
