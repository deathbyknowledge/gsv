import { describe, expect, it, vi } from "vitest";

import {
  deliverAdapterInboundResponses,
  InboundDeliveryLedger,
  isTerminalAdapterInboundResult,
} from "../src/inbound-delivery";

class MemoryTransaction {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly alarm: { value: number | null },
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm.value;
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm.value = value;
  }
}

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly alarm = { value: null as number | null };
  failNextDelete = false;

  async transaction<T>(
    closure: (txn: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await closure(new MemoryTransaction(this.values, this.alarm));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("simulated crash before local acknowledgement");
    }
    return this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm.value;
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm.value = value;
  }

  async list<T>(options?: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .slice(0, options?.limit);
    return new Map(entries) as Map<string, T>;
  }
}

function ledger(
  storage: MemoryStorage,
): InboundDeliveryLedger<{ providerMessageId: string }> {
  return new InboundDeliveryLedger(
    storage as unknown as DurableObjectStorage,
    "pending_inbound:",
  );
}

describe("InboundDeliveryLedger", () => {
  it("commits a provider payload with its earliest wake-up", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);

    await pending.enqueueAndArm(
      "provider-alarm",
      { providerMessageId: "original" },
      200,
    );
    await pending.enqueueAndArm(
      "provider-alarm",
      { providerMessageId: "replacement" },
      300,
    );
    await pending.arm(100);

    expect(storage.alarm.value).toBe(100);
    const deliver = vi.fn(async () => ({ terminal: true }));
    await pending.attempt("provider-alarm", deliver);
    expect(deliver).toHaveBeenCalledWith({ providerMessageId: "original" });
  });

  it("replays a durable provider payload after the Gateway transport fails", async () => {
    const storage = new MemoryStorage();
    const first = ledger(storage);
    await first.enqueueAndArm("provider-1", { providerMessageId: "provider-1" }, 100);

    await expect(first.attempt("provider-1", async () => {
      throw new Error("Kernel restarted before preparing the receipt");
    })).resolves.toEqual({
      state: "pending",
      error: "Kernel restarted before preparing the receipt",
    });

    const restarted = ledger(storage);
    const deliver = vi.fn(async () => ({ terminal: true }));
    await expect(restarted.pendingIds()).resolves.toEqual(["provider-1"]);
    await expect(restarted.attempt("provider-1", deliver)).resolves.toEqual({
      state: "completed",
    });
    expect(deliver).toHaveBeenCalledWith({ providerMessageId: "provider-1" });
    await expect(restarted.hasPending()).resolves.toBe(false);
  });

  it("keeps an in-progress Kernel replay pending", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    await pending.enqueueAndArm("provider-2", { providerMessageId: "provider-2" }, 100);

    const result = { ok: true as const, replayed: "in_progress" as const };
    await expect(pending.attempt("provider-2", async () => ({
      terminal: isTerminalAdapterInboundResult(result),
      error: "Kernel receipt is still in progress",
    }))).resolves.toEqual({
      state: "pending",
      error: "Kernel receipt is still in progress",
    });
    await expect(pending.pendingIds()).resolves.toEqual(["provider-2"]);
    expect(isTerminalAdapterInboundResult({
      ok: false,
      error: "durably rejected",
    })).toBe(true);
    expect(isTerminalAdapterInboundResult({
      ok: true,
      replayed: "completed",
    })).toBe(true);
    expect(isTerminalAdapterInboundResult({})).toBe(false);
    expect(isTerminalAdapterInboundResult({
      ok: true,
      replayed: "unexpected",
    })).toBe(false);
  });

  it("replays when the Kernel completed but the adapter crashed before deleting", async () => {
    const storage = new MemoryStorage();
    const first = ledger(storage);
    await first.enqueueAndArm("provider-3", { providerMessageId: "provider-3" }, 100);
    storage.failNextDelete = true;

    await expect(first.attempt("provider-3", async () => ({ terminal: true })))
      .rejects.toThrow("simulated crash");

    const restarted = ledger(storage);
    const replay = vi.fn(async () => ({ terminal: true }));
    await expect(restarted.attempt("provider-3", replay)).resolves.toEqual({
      state: "completed",
    });
    expect(replay).toHaveBeenCalledTimes(1);
    await expect(restarted.hasPending()).resolves.toBe(false);
  });

  it("does not overwrite a provider payload when the provider replays it", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    await pending.enqueueAndArm("provider-4", { providerMessageId: "original" }, 100);
    await pending.enqueueAndArm("provider-4", { providerMessageId: "replacement" }, 100);

    const deliver = vi.fn(async () => ({ terminal: true }));
    await pending.attempt("provider-4", deliver);
    expect(deliver).toHaveBeenCalledWith({ providerMessageId: "original" });
  });
});

describe("deliverAdapterInboundResponses", () => {
  const surface = { kind: "dm" as const, id: "chat-1" };

  it("uses stable response ids before releasing inbound ownership", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    await expect(deliverAdapterInboundResponses({
      ok: true,
      challenge: {
        deliveryId: "challenge-1",
        code: "CODE",
        prompt: "Link this account",
        expiresAt: 123,
      },
      reply: {
        deliveryId: "reply-1",
        text: "Done",
      },
    }, {
      surface,
      providerMessageId: "provider-1",
      send,
    })).resolves.toEqual({ terminal: true });

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        deliveryId: "challenge-1",
        surface,
        text: "Link this account",
        replyToId: "provider-1",
      },
      {
        deliveryId: "reply-1",
        surface,
        text: "Done",
        replyToId: "provider-1",
      },
    ]);
  });

  it("retains inbound ownership for a retry-safe response failure", async () => {
    await expect(deliverAdapterInboundResponses({
      ok: true,
      reply: { deliveryId: "reply-2", text: "Try again" },
    }, {
      surface,
      providerMessageId: "provider-2",
      send: vi.fn(async () => ({
        ok: false as const,
        error: "provider unavailable",
        retryable: true,
      })),
    })).resolves.toEqual({
      terminal: false,
      error: "provider unavailable",
    });
  });
});
