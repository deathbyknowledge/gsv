import { describe, expect, it, vi } from "vitest";
import { adapterGatewayFrameSchema } from "../../../packages/gsv/src/protocol/adapters";

import {
  callAdapterGateway,
  callLinkedAdapterGateway,
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
const CONTEXT = {
  accountId: "account-1",
  actorId: "actor-1",
  surface: { kind: "dm" as const, id: "surface-1" },
  routeGeneration: "route-1",
  interactionId: "interaction-1",
};
const ARGS = {
  pid: "proc-1",
  requestId: "request-1",
  decision: "approve" as const,
};

type TrackedBody = { body: BinaryBody; cancelled: () => Error | string | undefined };

function trackedBody(): TrackedBody {
  let cancelled: Error | string | undefined;
// SAFETY: This test fixture deliberately supplies the contract shape under test.
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
  return {
    serviceFrame: vi.fn(scopedServiceFrame),
    linkedPeerFrame: vi.fn(),
  };
}

function gatewayWithResponse(
  response: (frame: { id: string }) => GatewayFrame,
): AdapterGatewayBinding {
  const gateway = {
    serviceFrame: vi.fn(),
    linkedPeerFrame: vi.fn(async (_installation, _context, frame) => response(frame)),
  };
  // SAFETY: The fixture supplies both adapter Gateway methods exercised by these tests.
  return gateway as AdapterGatewayBinding;
}

describe("callAdapterGateway", () => {
  it("projects optional metadata to the receiver's JSON frame contract", async () => {
    let received: GatewayFrame | undefined;
    const serviceFrame = vi.fn(async (
      _installation: AdapterInstallationContext,
      frame: GatewayFrame,
    ) => {
      received = frame;
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
      {
        adapter: "telegram",
        accountId: "managed",
        deliveryId: "telegram:1",
        message: {
          messageId: "1",
          surface: { kind: "dm", id: "123", name: undefined },
          actor: { id: "123", handle: undefined },
          text: "/help",
          media: undefined,
          replyToId: undefined,
          timestamp: 1_700_000_000_000,
          wasMentioned: true,
        },
      },
    )).resolves.toEqual({ ok: true });

    expect(adapterGatewayFrameSchema.safeParse(received).success).toBe(true);
    expect(received).toMatchObject({
      type: "req",
      args: {
        adapter: "telegram",
        accountId: "managed",
        deliveryId: "telegram:1",
        message: {
          messageId: "1",
          surface: { kind: "dm", id: "123" },
          actor: { id: "123" },
          text: "/help",
          timestamp: 1_700_000_000_000,
          wasMentioned: true,
        },
      },
    });
  });

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

  it("passes explicit singleton context for standalone", async () => {
    const serviceFrame = vi.fn(async (
      _installation: AdapterInstallationContext,
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
      { installationId: "singleton" },
      "adapter.inbound",
      INBOUND_ARGS,
    )).resolves.toEqual({ ok: true });
    expect(serviceFrame).toHaveBeenCalledOnce();
    expect(serviceFrame).toHaveBeenCalledWith(
      { installationId: "singleton" },
      expect.objectContaining({ type: "req", call: "adapter.inbound" }),
    );
  });

  it("passes explicit installation context for managed installations", async () => {
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
      binding(async (_installation, frame) => ({
        type: "res",
        id: frame.type === "req" ? frame.id : "unexpected",
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
      binding(async (_installation, frame) => ({
        type: "res",
        id: frame.type === "req" ? frame.id : "unexpected",
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
      binding(async (_installation, frame) => ({
        type: "res",
        id: frame.type === "req" ? frame.id : "unexpected",
        ok: false,
      })),
      INSTALLATION,
      "adapter.state.update",
      STATE_UPDATE_ARGS,
    )).rejects.toThrow("Gateway error on adapter.state.update");
  });

  it("rejects a response correlated to another request", async () => {
    const requestBody = trackedBody();
    const responseBody = trackedBody();
    await expect(callAdapterGateway(
      binding(async (_installation, frame) => ({
        type: "res",
        id: frame.type === "req" ? `${frame.id}:mismatched` : "unexpected",
        ok: true,
        data: { ok: true },
        body: responseBody.body,
      })),
      INSTALLATION,
      "adapter.inbound",
      INBOUND_ARGS,
      requestBody.body,
    )).rejects.toThrow("No response from gateway serviceFrame");
    expect(requestBody.cancelled()).toBe("No response from gateway serviceFrame");
    expect(responseBody.cancelled()).toBe("No response from gateway serviceFrame");
  });
});

describe("callLinkedAdapterGateway", () => {
  it("cancels a mismatched linked-peer response body before rejecting it", async () => {
    const responseBody = trackedBody();
    const gateway = gatewayWithResponse((frame) => ({
      type: "res",
      id: `${frame.id}:mismatched`,
      ok: true,
      data: { ok: true },
      body: responseBody.body,
    }));

    await expect(callLinkedAdapterGateway(
      gateway,
      INSTALLATION,
      CONTEXT,
      "proc.hil",
      ARGS,
    )).rejects.toThrow("No response from linked adapter peer request");
    expect(responseBody.cancelled()).toBe(
      "Linked adapter response body is unsupported",
    );
  });

  it("returns a terminal domain rejection for a stale linked route", async () => {
    const gateway = gatewayWithResponse((frame) => ({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 409, message: "route changed" },
    }));

    await expect(callLinkedAdapterGateway(
      gateway,
      INSTALLATION,
      CONTEXT,
      "proc.hil",
      ARGS,
    )).resolves.toEqual({ ok: false, error: "route changed" });
  });

  it("retries a transient linked-peer failure", async () => {
    const gateway = gatewayWithResponse((frame) => ({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 503, message: "unavailable" },
    }));

    await expect(callLinkedAdapterGateway(
      gateway,
      INSTALLATION,
      CONTEXT,
      "proc.hil",
      ARGS,
    )).rejects.toThrow("unavailable");
  });
});
