import { describe, expect, it, vi } from "vitest";

import {
  createInferenceRequest,
  decodeInferenceRequest,
  decodeInferenceResponse,
  encodeInferenceError,
  encodeInferenceResult,
  InferenceProtocolError,
} from "../src/inference-transport";

describe("provider-neutral inference transport", () => {
  it("round trips strict run requests with headers and binary values", async () => {
    const request = createInferenceRequest({
      operation: "run",
      model: "provider/model",
      input: {
        prompt: "hello",
        bytes: new Uint8Array([1, 2, 3]),
        samples: new Uint16Array([256, 512]),
        omitted: undefined,
      },
      options: {
        headers: [["x-session-affinity", "session-1"]],
        returnRawResponse: true,
      },
    });

    const decoded = await decodeInferenceRequest(request);

    expect(decoded).toMatchObject({
      operation: "run",
      model: "provider/model",
      options: {
        headers: [["x-session-affinity", "session-1"]],
        returnRawResponse: true,
      },
    });
    if (decoded.operation !== "run") throw new Error("Expected run request");
    const input = decoded.input as {
      bytes: Uint8Array;
      samples: Uint16Array;
      omitted: undefined;
    };
    expect(input.bytes).toBeInstanceOf(Uint8Array);
    expect([...input.bytes]).toEqual([1, 2, 3]);
    expect(input.samples).toBeInstanceOf(Uint16Array);
    expect([...input.samples]).toEqual([256, 512]);
    expect(Object.hasOwn(input, "omitted")).toBe(true);
  });

  it("rejects unknown wire fields and cancels oversized bodies", async () => {
    const malformed = new Request("https://inference.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/vnd.gsv.inference-request+json; version=1" },
      body: JSON.stringify({ version: 1, operation: "models", surprise: true }),
    });
    await expect(decodeInferenceRequest(malformed)).rejects.toThrow("unsupported fields");

    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel: cancelled,
    });
    const oversized = new Request("https://inference.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/vnd.gsv.inference-request+json; version=1" },
      body,
      duplex: "half",
    } as RequestInit);

    await expect(decodeInferenceRequest(oversized, { maximumBodyBytes: 8 }))
      .rejects.toThrow("exceeds 8 bytes");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects non-canonical base64 binary values", async () => {
    const request = new Request("https://inference.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/vnd.gsv.inference-request+json; version=1" },
      body: JSON.stringify({
        version: 1,
        operation: "run",
        model: "provider/model",
        input: { t: "binary", k: "uint8-array", v: "AB==" },
      }),
    });

    await expect(decodeInferenceRequest(request)).rejects.toThrow("canonical base64");
  });

  it("preserves JSON and typed binary inference results", async () => {
    const json = await decodeInferenceResponse(encodeInferenceResult({
      response: "ok",
      bytes: new Uint8Array([4, 5, 6]),
    })) as { response: string; bytes: Uint8Array };
    expect(json.response).toBe("ok");
    expect([...json.bytes]).toEqual([4, 5, 6]);

    const binary = await decodeInferenceResponse(
      encodeInferenceResult(new Uint16Array([7, 8])),
    );
    expect(binary).toBeInstanceOf(Uint16Array);
    expect([...(binary as Uint16Array)]).toEqual([7, 8]);
  });

  it("preserves raw Response status, headers, and streaming body", async () => {
    const source = new Response("raw-body", {
      status: 206,
      statusText: "Partial",
      headers: {
        "content-type": "text/custom",
        "x-model": "model-1",
      },
    });

    const decoded = await decodeInferenceResponse(encodeInferenceResult(source));

    expect(decoded).toBeInstanceOf(Response);
    const response = decoded as Response;
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial");
    expect(response.headers.get("content-type")).toBe("text/custom");
    expect(response.headers.get("x-model")).toBe("model-1");
    expect(response.headers.get("x-gsv-inference-result")).toBeNull();
    await expect(response.text()).resolves.toBe("raw-body");
  });

  it("passes readable results through without buffering and preserves cancellation", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      cancel: cancelled,
    });

    const decoded = await decodeInferenceResponse(encodeInferenceResult(source));

    expect(decoded).toBeInstanceOf(ReadableStream);
    const reader = (decoded as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("caller stopped");
    expect(cancelled).toHaveBeenCalledWith("caller stopped");
  });

  it("returns bounded typed errors and rejects malformed binary lengths", async () => {
    await expect(decodeInferenceResponse(
      encodeInferenceError(new TypeError("upstream rejected the request"), 429),
    )).rejects.toMatchObject({
      name: "TypeError",
      message: "upstream rejected the request",
      status: 429,
    });

    const malformed = encodeInferenceResult(new Uint8Array([1]));
    const headers = new Headers(malformed.headers);
    headers.set("x-gsv-inference-binary", "uint16-array");
    const invalid = new Response(malformed.body, { headers });
    await expect(decodeInferenceResponse(invalid)).rejects.toBeInstanceOf(InferenceProtocolError);
  });
});
