import { describe, expect, it, vi } from "vitest";
import { ownInferenceBody } from "./owned-body";

describe("inference response body ownership", () => {
  it.each(["abort", "consumer"] as const)("finishes on %s cancellation when upstream cancellation never settles", async (source) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const upstream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const onCancel = vi.fn();
    const onFinish = vi.fn();
    const body = ownInferenceBody(upstream, controller.signal, onCancel, onFinish);
    const reason = new Error("cancelled");
    if (source === "abort") {
      controller.abort(reason);
      await expect(new Response(body).text()).rejects.toThrow("cancelled");
    } else {
      const pending = body.cancel(reason);
      expect(onFinish).toHaveBeenCalledOnce();
      await pending;
      controller.abort(reason);
    }
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
  });
});
