import { describe, expect, it, vi } from "vitest";

import {
  InboundDeliveryLedger,
  isTerminalAdapterInboundResult,
} from "../src/inbound-delivery";

class MemoryTransaction {
  constructor(private readonly values: Map<string, unknown>) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  failNextDelete = false;

  async transaction<T>(
    closure: (txn: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await closure(new MemoryTransaction(this.values));
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
  it("replays a durable provider payload after the Gateway transport fails", async () => {
    const storage = new MemoryStorage();
    const first = ledger(storage);
    await first.enqueue("provider-1", { providerMessageId: "provider-1" });

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
    await pending.enqueue("provider-2", { providerMessageId: "provider-2" });

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
    await first.enqueue("provider-3", { providerMessageId: "provider-3" });
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
    await pending.enqueue("provider-4", { providerMessageId: "original" });
    await pending.enqueue("provider-4", { providerMessageId: "replacement" });

    const deliver = vi.fn(async () => ({ terminal: true }));
    await pending.attempt("provider-4", deliver);
    expect(deliver).toHaveBeenCalledWith({ providerMessageId: "original" });
  });
});
