import { describe, expect, it, vi } from "vitest";

import {
  AdapterPeerDeliveryQueue,
  type AdapterPeerDeliveryAttemptHandlers,
  type AdapterPeerSignalDelivery,
} from "../src/peer-delivery";
import { runAdapterPeerSqlMigrations } from "../src/schema/migrations";
import type { BinaryBody } from "../src/types";
import { TestDurableObjectStorage } from "./sqlite-storage";

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
  const storage = new TestDurableObjectStorage();
  const durableStorage = storage.asDurableStorage();
  runAdapterPeerSqlMigrations(durableStorage);
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
      claim: vi.fn(async (value) => {
        expect(value).toEqual(accepted);
        return true;
      }),
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
    const completed = storage.rows<{ record_json: string }>(
      "SELECT record_json FROM adapter_peer_deliveries WHERE delivery_id = ?",
      "message-1",
    )[0];
    expect(JSON.parse(completed.record_json)).not.toHaveProperty("delivery");
  });

  it("re-arms after a staging alarm fires while the body is being stored", async () => {
    const { queue, storage } = queueFixture();
    const alarmAt = Date.now() + 1_000;
    storage.clearAlarmOnChunkWrite = true;

    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), alarmAt);

    expect(storage.alarm).toBe(alarmAt);
    await expect(queue.pendingIds()).resolves.toEqual(["message-1"]);
  });

  it("schedules retained stage cleanup when no delivery record exists", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { queue, storage } = queueFixture();
      storage.sql.exec(
        `INSERT INTO adapter_peer_delivery_stages (stage_id, delivery_id, created_at)
         VALUES (?, ?, ?)`,
        "orphan",
        "orphan",
        Date.now(),
      );
      storage.sql.exec(
        `INSERT INTO adapter_peer_delivery_chunks (stage_id, chunk_index, content)
         VALUES (?, ?, ?)`,
        "orphan",
        0,
        new Uint8Array([1, 2, 3, 4]).buffer,
      );

      await expect(queue.armIfPending(1_100)).resolves.toBe(false);
      expect(storage.alarm).toBe(3_601_000);

      storage.alarm = null;
      vi.setSystemTime(3_601_000);
      await expect(queue.armIfPending(3_601_100)).resolves.toBe(false);
      expect(storage.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM adapter_peer_delivery_stages",
      )[0].count).toBe(0);
      expect(storage.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM adapter_peer_delivery_chunks",
      )[0].count).toBe(0);
      expect(storage.alarm).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("coalesces concurrent queue drains", async () => {
    const { queue } = queueFixture();
    await queue.enqueueAndArm(delivery(), body([1, 2, 3, 4]), 10);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async () => {
      await blocked;
      return { ok: true as const, messageId: "provider-1" };
    });
    const handlers: AdapterPeerDeliveryAttemptHandlers = {
      claim: vi.fn(async () => true),
      deliver,
      report: vi.fn(async () => undefined),
    };

    const first = queue.drain(handlers);
    const second = queue.drain(handlers);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledOnce();
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
    expect(storage.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM adapter_peer_delivery_chunks",
    )[0].count).toBeGreaterThan(0);

    await expect(queue.attempt("message-1", handlers)).resolves.toBe("completed");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
    expect(storage.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM adapter_peer_delivery_chunks",
    )[0].count).toBe(0);
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
