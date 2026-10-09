import { describe, expect, it, vi } from "vitest";
import type { AdapterSendArgs } from "../../../../packages/gsv/src/protocol/syscalls/adapter";

import { handleAdapterFrame } from "../src/adapter-frame";
import type {
  AdapterDeliveryContext,
  BinaryBody,
  GatewayRequestFrame,
} from "../src/types";

const CONTEXT: AdapterDeliveryContext = {
  deliveryId: "message-1",
  accountId: "account-1",
  actorId: "actor-1",
  surface: { kind: "dm", id: "surface-1" },
  processId: "proc-1",
  runId: "run-1",
};

type TrackedBody = {
  body: BinaryBody;
  cancelled: () => Error | string | undefined;
};

function sendFrame(overrides: Partial<AdapterSendArgs> = {}): GatewayRequestFrame {
  return {
    type: "req",
    id: "request-1",
    call: "adapter.send",
    args: {
      adapter: "test",
      accountId: "account-1",
      deliveryId: "message-1",
      surface: { kind: "dm", id: "surface-1" },
      text: "hello",
      ...overrides,
    },
  };
}

function trackedBody(): TrackedBody {
  let cancelled: Error | string | undefined;
  return {
    body: {
      length: 3,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
        cancel(reason) {
          cancelled = reason instanceof Error ? reason : String(reason);
        },
      }),
    },
    cancelled: () => cancelled,
  };
}

describe("handleAdapterFrame", () => {
  it("dispatches adapter.send as a correlated request with its frame body", async () => {
    const tracked = trackedBody();
    const send = vi.fn(async (delivery, body?: BinaryBody) => {
      expect(delivery.message.text).toBe("hello");
      expect(body).toBe(tracked.body);
      return { ok: true as const, messageId: "provider-1" };
    });
    const frame = sendFrame();
    if (frame.type !== "req") throw new Error("expected request");
    frame.body = tracked.body;

    await expect(handleAdapterFrame(
      "test",
      CONTEXT,
      frame,
      { send },
    )).resolves.toEqual({
      type: "res",
      id: "request-1",
      ok: true,
      data: {
        ok: true,
        adapter: "test",
        accountId: "account-1",
        surfaceId: "surface-1",
        deliveryId: "message-1",
        messageId: "provider-1",
        deliveryState: "sent",
      },
    });
    expect(tracked.cancelled()).toBe("Adapter request completed");
  });

  it.each([false, true])("preserves provider diagnostics through the public frame (ambiguous: %s)", async (ambiguous) => {
    const diagnostics = { exceptionName: "APIError", exceptionMessage: "Provider rejected the delivery", errorCode: "131026", providerStatusCode: 400, providerRequestId: "trace-123" };
    const result = await handleAdapterFrame("test", CONTEXT, sendFrame(), {
      send: async () => ({ ok: false, error: "Provider rejected the delivery", ambiguous, diagnostics }),
    });
    expect(result).toMatchObject({ type: "res", ok: true, data: {
      ok: ambiguous, diagnostics, ...(ambiguous ? { deliveryState: "ambiguous" } : { retryable: false }),
    } });
  });

  it("retains diagnostics when the provider handler throws", async () => {
    const result = await handleAdapterFrame("test", CONTEXT, sendFrame(), { send: async () => {
      throw Object.assign(new TypeError("Provider disconnected token=private-key"), { request: { body: "private message" } });
    } });
    expect(result).toMatchObject({ ok: true, data: { ok: false, retryable: true, diagnostics: {
      exceptionName: "TypeError", exceptionMessage: "Provider disconnected token=[redacted]",
      exceptionStack: expect.stringContaining("TypeError: Provider disconnected"),
    } } });
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(JSON.stringify(result)).not.toContain("private message");
  });

  it("rejects a request that does not match its trusted route", async () => {
    const tracked = trackedBody();
    const frame = sendFrame({ deliveryId: "other-message" });
    if (frame.type !== "req") throw new Error("expected request");
    frame.body = tracked.body;

    await expect(handleAdapterFrame(
      "test",
      CONTEXT,
      frame,
      { send: vi.fn() },
    )).resolves.toMatchObject({
      type: "res",
      id: "request-1",
      ok: false,
      error: { code: 400 },
    });
    expect(tracked.cancelled()).toBeInstanceOf(Error);
  });

  it("passes the exact structured approval to adapter rendering", async () => {
    const hil = {
      pid: "proc-1",
      requestId: "approval-1",
      runId: "run-1",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: "echo hello" },
      createdAt: 1,
    } as const;
    const context: AdapterDeliveryContext = {
      ...CONTEXT,
      deliveryId: "run-1:hil:approval-1",
      hil,
    };
    const frame = sendFrame({ deliveryId: context.deliveryId, text: "" });
    const send = vi.fn(async (delivery) => {
      expect(delivery.hil).toEqual(hil);
      expect(delivery.message.text).toContain("echo hello");
      return { ok: true as const };
    });

    await expect(handleAdapterFrame(
      "test",
      context,
      frame,
      { send },
    )).resolves.toMatchObject({
      type: "res",
      id: "request-1",
      ok: true,
    });
  });
});
