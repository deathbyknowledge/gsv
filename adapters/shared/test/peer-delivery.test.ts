import { describe, expect, it, vi } from "vitest";

import {
  AdapterPeerDeliveryQueue,
  type AdapterPeerDeliveryAttemptHandlers,
  type AdapterPeerSignalDelivery,
} from "../src/peer-delivery";
import type { BinaryBody } from "../src/types";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  clearAlarmOnBodyPut = false;

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: The fixture returns the generic value previously written for this key.
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    // SAFETY: The fixture map is exposed through the generic storage list contract.
    return new Map(
      [...this.values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)),
    ) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
    if (this.clearAlarmOnBodyPut && key.startsWith("peer_delivery:v1:body:")) {
      this.clearAlarmOnBodyPut = false;
      this.alarm = null;
    }
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce((count, item) => count + (this.values.delete(item) ? 1 : 0), 0);
    }
    return this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarm = value instanceof Date ? value.getTime() : value;
  }

  async transaction<T>(closure: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    return await closure(this);
  }
}

function body(bytes: number[]): BinaryBody {
  const value = new Uint8Array(bytes);
  return {
    length: value.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(value);
        controller.close();
      },
    }),
  };
}

function delivery(id = "message-1"): AdapterPeerSignalDelivery {
  return {
    installation: { installationId: "inst_test" },
    context: {
      deliveryId: id,
      accountId: "account-1",
      actorId: "actor-1",
      surface: { kind: "dm", id: "surface-1" },
      processId: "proc-1",
      runId: "run-1",
      media: [{
        type: "document",
        mimeType: "application/octet-stream",
        body: { offset: 0, length: 4 },
      }],
    },
    frame: {
      type: "sig",
      signal: "message.committed",
      payload: {
        message: {
          id,
          conversationId: "conversation-1",
          sequence: 1,
          author: { kind: "process", pid: "proc-1", uid: 1000 },
          text: "file",
          origin: { kind: "process", pid: "proc-1", runId: "run-1" },
          processId: "proc-1",
          runId: "run-1",
          createdAt: 1,
        },
        directed: true,
      },
    },
  };
}

function queueFixture() {
  const storage = new MemoryStorage();
  // SAFETY: The fixture implements every Durable Object storage operation used by the queue.
  const durableStorage = storage as DurableObjectStorage;
  return {
    storage,
    queue: new AdapterPeerDeliveryQueue(durableStorage, 100),
  };
}

describe("AdapterPeerDeliveryQueue", () => {
  it("persists the exact signal and body before provider delivery", async () => {
    const { queue, storage } = queueFixture();
    const accepted = delivery();
    await queue.enqueueAndArm(accepted, body([1, 2, 3, 4]), 10);

    const deliveredBytes: number[] = [];
    const handlers: AdapterPeerDeliveryAttemptHandlers = {
      claim: vi.fn(async (value) => value === accepted),
      deliver: vi.fn(async (value, requestBody) => {
        expect(value).toEqual(accepted);
        const bytes = new Uint8Array(await new Response(requestBody?.stream).arrayBuffer());
        deliveredBytes.push(...bytes);
        return { ok: true, messageId: "provider-1" };
      }),
      report: vi.fn(async () => undefined),
    };

    await expect(queue.attempt("message-1", handlers)).resolves.toBe("completed");
    expect(deliveredBytes).toEqual([1, 2, 3, 4]);
    expect(handlers.report).toHaveBeenCalledWith(accepted, {
      state: "sent",
      messageId: "provider-1",
      attempts: 1,
    });
    expect(storage.values.get("peer_delivery:v1:record:message-1"))
      .not.toHaveProperty("delivery");
  });

  it("re-arms after a staging alarm fires while the body is being stored", async () => {
    const { queue, storage } = queueFixture();
    const alarmAt = Date.now() + 1_000;
    storage.clearAlarmOnBodyPut = true;

    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), alarmAt);

    expect(storage.alarm).toBe(alarmAt);
    await expect(queue.pendingIds()).resolves.toEqual(["message-1"]);
  });

  it("retries only a retry-safe provider rejection with the same delivery", async () => {
    const { queue } = queueFixture();
    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), 10);
    const deliver = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "busy", retryable: true })
      .mockResolvedValueOnce({ ok: true, messageId: "provider-2" });
    const report = vi.fn(async () => undefined);
    const handlers: AdapterPeerDeliveryAttemptHandlers = {
      claim: vi.fn(async () => true),
      deliver,
      report,
    };

    await expect(queue.attempt("message-1", handlers)).resolves.toBe("pending");
    expect(report).not.toHaveBeenCalled();
    await expect(queue.attempt("message-1", handlers)).resolves.toBe("completed");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(expect.anything(), {
      state: "sent",
      messageId: "provider-2",
      attempts: 2,
    });
  });

  it("does not call the provider after the Kernel rejects a stale route", async () => {
    const { queue } = queueFixture();
    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), 10);
    const deliver = vi.fn();
    const report = vi.fn();

    await expect(queue.attempt("message-1", {
      claim: vi.fn(async () => false),
      deliver,
      report,
    })).resolves.toBe("completed");
    expect(deliver).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("retains body cleanup ownership while a Kernel outcome report retries", async () => {
    const { queue, storage } = queueFixture();
    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), 10);
    const deliver = vi.fn(async () => ({ ok: true as const, messageId: "provider-1" }));
    const report = vi.fn()
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce(undefined);
    const handlers: AdapterPeerDeliveryAttemptHandlers = {
      claim: vi.fn(async () => true),
      deliver,
      report,
    };

    await expect(queue.attempt("message-1", handlers)).resolves.toBe("pending");
    expect([...storage.values.keys()].some(
      (key) => key.startsWith("peer_delivery:v1:body:"),
    )).toBe(true);

    await expect(queue.attempt("message-1", handlers)).resolves.toBe("completed");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
    expect([...storage.values.keys()].some(
      (key) => key.startsWith("peer_delivery:v1:body:"),
    )).toBe(false);
  });

  it("deduplicates a repeated durable handoff and rejects conflicting reuse", async () => {
    const { queue } = queueFixture();
    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), 10);
    await expect(queue.enqueueAndArm(
      delivery(),
      body([1, 2, 3, 4]),
      10,
    )).resolves.toBeUndefined();
    await expect(queue.enqueueAndArm(
      delivery(),
      body([4, 3, 2, 1]),
      10,
    )).rejects.toThrow("already bound");
  });
});
