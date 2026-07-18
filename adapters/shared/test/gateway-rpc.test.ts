import { describe, expect, it, vi } from "vitest";

import {
  callAdapterGateway,
  type AdapterGatewayBinding,
} from "../src/gateway-rpc";
import type { BinaryBody, GatewayFrame } from "../src/types";

function trackedBody(): {
  body: BinaryBody;
  cancelled: () => unknown;
} {
  let cancelled: unknown;
  return {
    body: {
      stream: new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelled = reason;
        },
      }),
    },
    cancelled: () => cancelled,
  };
}

function binding(
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>,
): AdapterGatewayBinding {
  return { serviceFrame };
}

describe("callAdapterGateway", () => {
  it("forwards the request body and returns typed response data", async () => {
    const request = trackedBody();
    const serviceFrame = vi.fn(async (frame: GatewayFrame) => {
      expect(frame).toMatchObject({
        type: "req",
        call: "adapter.inbound",
        args: { value: 1 },
        body: request.body,
      });
      expect(frame.type === "req" && frame.id).toMatch(/^[0-9a-f-]{36}$/);
      return {
        type: "res" as const,
        id: frame.type === "req" ? frame.id : "unexpected",
        ok: true,
        data: { accepted: true },
      };
    });

    await expect(callAdapterGateway<{ accepted: boolean }>(
      binding(serviceFrame),
      "adapter.inbound",
      { value: 1 },
      request.body,
    )).resolves.toEqual({ accepted: true });
    expect(request.cancelled()).toBeUndefined();
  });

  it("cancels the request body when the binding throws or returns no response", async () => {
    const transportBody = trackedBody();
    const transportError = new Error("transport failed");
    await expect(callAdapterGateway(
      binding(async () => {
        throw transportError;
      }),
      "adapter.inbound",
      {},
      transportBody.body,
    )).rejects.toBe(transportError);
    expect(transportBody.cancelled()).toBe(transportError);

    const missingBody = trackedBody();
    await expect(callAdapterGateway(
      binding(async () => null),
      "adapter.inbound",
      {},
      missingBody.body,
    )).rejects.toThrow("No response from gateway serviceFrame");
    expect(missingBody.cancelled()).toBe("No response from gateway serviceFrame");
  });

  it("cancels unexpected frame bodies and preserves the missing-response error", async () => {
    const request = trackedBody();
    const unexpected = trackedBody();

    await expect(callAdapterGateway(
      binding(async () => ({
        type: "req",
        id: "unexpected",
        call: "adapter.inbound",
        args: {},
        body: unexpected.body,
      })),
      "adapter.inbound",
      {},
      request.body,
    )).rejects.toThrow("No response from gateway serviceFrame");

    expect(request.cancelled()).toBe("No response from gateway serviceFrame");
    expect(unexpected.cancelled()).toBe("No response from gateway serviceFrame");
  });

  it("cancels response bodies on success and Gateway errors", async () => {
    const successBody = trackedBody();
    await expect(callAdapterGateway(
      binding(async () => ({
        type: "res",
        id: "success",
        ok: true,
        body: successBody.body,
      })),
      "adapter.state.update",
      {},
    )).resolves.toEqual({});
    expect(successBody.cancelled()).toBe(
      "Gateway response body is not consumed by adapters",
    );

    const acceptedRequestBody = trackedBody();
    const errorBody = trackedBody();
    await expect(callAdapterGateway(
      binding(async () => ({
        type: "res",
        id: "error",
        ok: false,
        error: { message: "Gateway rejected message" },
        body: errorBody.body,
      })),
      "adapter.inbound",
      {},
      acceptedRequestBody.body,
    )).rejects.toThrow("Gateway rejected message");
    expect(acceptedRequestBody.cancelled()).toBeUndefined();
    expect(errorBody.cancelled()).toBe("Gateway rejected message");
  });

  it("uses the existing call-specific fallback for malformed error responses", async () => {
    await expect(callAdapterGateway(
      binding(async () => ({
        type: "res",
        id: "error",
        ok: false,
      })),
      "adapter.state.update",
      {},
    )).rejects.toThrow("Gateway error on adapter.state.update");
  });
});
