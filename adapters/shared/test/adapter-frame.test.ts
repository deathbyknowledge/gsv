import { describe, expect, it, vi } from "vitest";

import { handleAdapterFrame } from "../src/adapter-frame";
import type {
  AdapterPeerDeliveryContext,
  BinaryBody,
  GatewayFrame,
} from "../src/types";

const INSTALLATION = { installationId: "inst_test" } as const;
const CONTEXT: AdapterPeerDeliveryContext = {
  deliveryId: "message-1",
  accountId: "account-1",
  actorId: "actor-1",
  surface: { kind: "dm", id: "surface-1" },
  processId: "proc-1",
  runId: "run-1",
};

function committedFrame(): GatewayFrame {
  return {
    type: "sig",
    signal: "message.committed",
    payload: {
      message: {
        id: "message-1",
        conversationId: "conversation-1",
        sequence: 1,
        author: { kind: "process", pid: "proc-1", uid: 1000 },
        text: "hello",
        origin: { kind: "process", pid: "proc-1", runId: "run-1" },
        processId: "proc-1",
        runId: "run-1",
        createdAt: 1,
      },
      directed: true,
    },
  };
}

function trackedBody(): { body: BinaryBody; cancelled: () => unknown } {
  let cancelled: unknown;
  return {
    body: {
      length: 3,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
        cancel(reason) {
          cancelled = reason;
        },
      }),
    },
    cancelled: () => cancelled,
  };
}

describe("handleAdapterFrame", () => {
  it("acknowledges a signal only after durable adapter acceptance", async () => {
    let release!: () => void;
    const accepted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = handleAdapterFrame(
      "test",
      INSTALLATION,
      CONTEXT,
      committedFrame(),
      undefined,
      {
        send: vi.fn(),
        acceptSignal: vi.fn(async () => await accepted),
      },
    ).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBeNull();
  });

  it("rejects a signal whose structured payload does not match its route", async () => {
    const tracked = trackedBody();
    const frame = committedFrame();
    if (frame.type !== "sig" || frame.signal !== "message.committed") {
      throw new Error("expected committed signal");
    }
    frame.payload.message.runId = "other-run";

    await expect(handleAdapterFrame(
      "test",
      INSTALLATION,
      CONTEXT,
      frame,
      tracked.body,
      { send: vi.fn(), acceptSignal: vi.fn() },
    )).rejects.toThrow("does not match");
    expect(tracked.cancelled()).toBeInstanceOf(Error);
  });

  it("dispatches adapter.send as a correlated request with its frame body", async () => {
    const tracked = trackedBody();
    const send = vi.fn(async (_message, body?: BinaryBody) => {
      expect(body).toBe(tracked.body);
      return { ok: true as const, messageId: "provider-1" };
    });
    const frame: GatewayFrame = {
      type: "req",
      id: "request-1",
      call: "adapter.send",
      args: {
        adapter: "test",
        accountId: "account-1",
        deliveryId: "message-1",
        surface: { kind: "dm", id: "surface-1" },
        text: "hello",
      },
      body: tracked.body,
    };

    await expect(handleAdapterFrame(
      "test",
      INSTALLATION,
      CONTEXT,
      frame,
      undefined,
      { send, acceptSignal: vi.fn() },
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
});
