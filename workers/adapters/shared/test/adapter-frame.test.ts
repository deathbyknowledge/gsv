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
