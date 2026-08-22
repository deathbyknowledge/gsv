import { describe, expect, it, vi } from "vitest";

import {
  callAdapterGateway,
  type AdapterGatewayBinding,
} from "../src/gateway-rpc";
import type {
  AdapterInstallationContext,
  BinaryBody,
  GatewayFrame,
} from "../src/types";

const INSTALLATION = { installationId: "inst_test" } as const;
const INBOUND_ARGS = {
  adapter: "test",
  accountId: "account",
  deliveryId: "delivery-1",
  message: {
    messageId: "provider-1",
    surface: { kind: "dm", id: "dm-1" },
    text: "hello",
  },
} as const;
const STATE_UPDATE_ARGS = {
  adapter: "test",
  accountId: "account",
  status: {
    accountId: "account",
    connected: true,
    authenticated: true,
  },
} as const;

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
  scopedServiceFrame: (
    installation: AdapterInstallationContext,
    frame: GatewayFrame,
  ) => Promise<GatewayFrame | null>,
): AdapterGatewayBinding {
  const serviceFrame = vi.fn(async (
    installationOrFrame: AdapterInstallationContext | GatewayFrame,
    scopedFrame?: GatewayFrame,
  ) => scopedFrame
    ? await scopedServiceFrame(
        installationOrFrame as AdapterInstallationContext,
        scopedFrame,
      )
    : null);
  return {
    serviceFrame: serviceFrame as AdapterGatewayBinding["serviceFrame"],
  };
}

describe("callAdapterGateway", () => {
  it("forwards the request body and returns typed response data", async () => {
    const request = trackedBody();
    const serviceFrame = vi.fn(async (
      installation: AdapterInstallationContext,
      frame: GatewayFrame,
    ) => {
      expect(installation).toEqual(INSTALLATION);
      expect(frame).toMatchObject({
        type: "req",
        call: "adapter.inbound",
        args: INBOUND_ARGS,
        body: request.body,
      });
      expect(frame.type === "req" && frame.id).toMatch(/^[0-9a-f-]{36}$/);
      return {
        type: "res" as const,
        id: frame.type === "req" ? frame.id : "unexpected",
        ok: true,
        data: { ok: true },
      };
    });

    await expect(callAdapterGateway(
      binding(serviceFrame),
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
      request.body,
    )).resolves.toEqual({ ok: true });
    expect(serviceFrame).toHaveBeenCalledOnce();
    expect(request.cancelled()).toBeUndefined();
  });

  it("uses the legacy one-argument Gateway RPC for standalone", async () => {
    const serviceFrame = vi.fn(async (frame: GatewayFrame) => ({
      type: "res" as const,
      id: frame.type === "req" ? frame.id : "unexpected",
      ok: true,
      data: { ok: true },
    }));
    const gateway: AdapterGatewayBinding = {
      serviceFrame,
    };

    await expect(callAdapterGateway(
      gateway,
      { installationId: "singleton" },
      "adapter.inbound",
      INBOUND_ARGS,
    )).resolves.toEqual({ ok: true });
    expect(serviceFrame).toHaveBeenCalledOnce();
    expect(serviceFrame).toHaveBeenCalledWith(expect.objectContaining({
      type: "req",
      call: "adapter.inbound",
    }));
  });

  it("uses the already-deployed two-argument Gateway RPC for managed installations", async () => {
    const serviceFrame = vi.fn(async (
      installation: AdapterInstallationContext,
      frame: GatewayFrame,
    ) => ({
      type: "res" as const,
      id: frame.type === "req" ? frame.id : "unexpected",
      ok: true,
      data: { ok: true },
    }));
    const gateway = binding(serviceFrame);

    await expect(callAdapterGateway(
      gateway,
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
    )).resolves.toEqual({ ok: true });
    expect(serviceFrame).toHaveBeenCalledOnce();
    expect(serviceFrame).toHaveBeenCalledWith(
      INSTALLATION,
      expect.objectContaining({ type: "req", call: "adapter.inbound" }),
    );
  });

  it("cancels the request body when the binding throws or returns no response", async () => {
    const transportBody = trackedBody();
    const transportError = new Error("transport failed");
    await expect(callAdapterGateway(
      binding(async () => {
        throw transportError;
      }),
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
      transportBody.body,
    )).rejects.toBe(transportError);
    expect(transportBody.cancelled()).toBe(transportError);

    const missingBody = trackedBody();
    await expect(callAdapterGateway(
      binding(async () => null),
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
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
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
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
        data: { ok: true },
        body: successBody.body,
      })),
      INSTALLATION,
      "adapter.state.update",
      STATE_UPDATE_ARGS,
    )).resolves.toEqual({ ok: true });
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
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
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
      INSTALLATION,
      "adapter.state.update",
      STATE_UPDATE_ARGS,
    )).rejects.toThrow("Gateway error on adapter.state.update");
  });
});
