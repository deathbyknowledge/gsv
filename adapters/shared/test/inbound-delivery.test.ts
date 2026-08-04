import { describe, expect, it, vi } from "vitest";

import {
  adapterInboundResultDisposition,
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

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce(
        (count, item) => count + (this.values.delete(item) ? 1 : 0),
        0,
      );
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

  it("repairs alarms in every scheduling path without postponing earlier work", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      await pending.arm(1_200);
      expect(storage.alarm.value).toBe(1_200);

      storage.alarm.value = 900;
      await pending.arm(1_300);
      expect(storage.alarm.value).toBe(1_300);

      storage.alarm.value = 1_400;
      await pending.arm(1_250);
      expect(storage.alarm.value).toBe(1_250);

      storage.alarm.value = 1_100;
      await pending.arm(1_200);
      expect(storage.alarm.value).toBe(1_100);

      const enqueueStorage = new MemoryStorage();
      enqueueStorage.alarm.value = 900;
      await ledger(enqueueStorage).enqueueAndArm(
        "provider-enqueue-overdue",
        { providerMessageId: "provider-enqueue-overdue" },
        1_200,
      );
      expect(enqueueStorage.alarm.value).toBe(1_200);

      const pendingStorage = new MemoryStorage();
      pendingStorage.values.set("pending_inbound:provider-pending-overdue", {
        state: "provider",
        payload: { providerMessageId: "provider-pending-overdue" },
        createdAt: 900,
      });
      pendingStorage.alarm.value = 900;
      await expect(ledger(pendingStorage).armIfPending(1_400)).resolves.toBe(true);
      expect(pendingStorage.alarm.value).toBe(1_400);
    } finally {
      clock.mockRestore();
    }
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
    await expect(restarted.pendingIds()).resolves.toEqual([]);
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
    await expect(restarted.pendingIds()).resolves.toEqual([]);
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

  it("re-arms durable ingress before retry work starts", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    await pending.enqueueAndArm("provider-5", { providerMessageId: "provider-5" }, 200);

    storage.alarm.value = null;
    await expect(pending.armIfPending(100)).resolves.toBe(true);
    expect(storage.alarm.value).toBe(100);

    await pending.attempt("provider-5", async () => ({ terminal: true }));
    storage.alarm.value = null;
    await expect(pending.armIfPending(300)).resolves.toBe(false);
    expect(storage.alarm.value).toBeNull();
  });

  it("fences an active attempt when all pending handoffs are cleared", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    await pending.enqueueAndArm("old-session", { providerMessageId: "old" }, 100);
    let release!: () => void;
    let markEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const send = vi.fn(async () => ({ ok: true as const }));
    const attempt = pending.attempt("old-session", async () => {
      markEntered();
      await held;
      return adapterInboundResultDisposition({
        ok: true,
        reply: { deliveryId: "stale-reply", text: "Do not send" },
      }, {
        surface: { kind: "dm", id: "old-chat" },
        providerMessageId: "old",
      });
    }, send);

    await entered;
    await expect(pending.clear()).resolves.toBe(1);
    release();
    await expect(attempt).resolves.toEqual({ state: "completed" });
    expect(send).not.toHaveBeenCalled();
    await expect(pending.pendingIds()).resolves.toEqual([]);
  });

  it("persists normalized responses before retrying provider delivery", async () => {
    const storage = new MemoryStorage();
    const first = ledger(storage);
    const surface = { kind: "dm" as const, id: "chat-1" };
    await first.enqueueAndArm("provider-6", { providerMessageId: "provider-6" }, 100);

    const enterKernel = vi.fn(async () => adapterInboundResultDisposition({
      ok: true,
      reply: { deliveryId: "reply-6", text: "Try again" },
    }, { surface, providerMessageId: "provider-6" }));
    const send = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: "provider unavailable",
        retryable: true,
      })
      .mockResolvedValueOnce({ ok: true as const });

    await expect(first.attempt("provider-6", enterKernel, send)).resolves.toEqual({
      state: "pending",
      error: "provider unavailable",
    });
    expect(enterKernel).toHaveBeenCalledTimes(1);

    const restarted = ledger(storage);
    const unexpectedKernelReplay = vi.fn(async () => ({ terminal: true }));
    await expect(restarted.attempt(
      "provider-6",
      unexpectedKernelReplay,
      send,
    )).resolves.toEqual({ state: "completed" });
    expect(unexpectedKernelReplay).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  });

  it("persists response authorization context across provider retries", async () => {
    const storage = new MemoryStorage();
    const first = new InboundDeliveryLedger<
      { providerMessageId: string },
      { installationId: string }
    >(
      storage as unknown as DurableObjectStorage,
      "managed_inbound:",
    );
    await first.enqueueAndArm("provider-context", {
      providerMessageId: "provider-context",
    }, 100);
    const send = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: "provider unavailable",
        retryable: true,
      })
      .mockResolvedValueOnce({ ok: true as const });

    await expect(first.attempt("provider-context", async () => ({
      terminal: true,
      responses: [{
        message: {
          deliveryId: "reply-context",
          surface: { kind: "dm", id: "chat-context" },
          text: "Bound reply",
        },
        context: { installationId: "inst_original" },
      }],
    }), send)).resolves.toMatchObject({ state: "pending" });

    const restarted = new InboundDeliveryLedger<
      { providerMessageId: string },
      { installationId: string }
    >(
      storage as unknown as DurableObjectStorage,
      "managed_inbound:",
    );
    await expect(restarted.attempt(
      "provider-context",
      async () => ({ terminal: true }),
      send,
    )).resolves.toEqual({ state: "completed" });
    expect(send.mock.calls[0]?.[1]).toEqual({ installationId: "inst_original" });
    expect(send.mock.calls[1]?.[1]).toEqual({ installationId: "inst_original" });
  });

  it("attempts every response in a retry round", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    await pending.enqueueAndArm("provider-multi", {
      providerMessageId: "provider-multi",
    }, 100);
    const send = vi.fn(async (message: { deliveryId: string }) =>
      message.deliveryId === "challenge-multi"
        ? {
            ok: false as const,
            error: "challenge unavailable",
            retryable: true,
          }
        : { ok: true as const }
    );

    await expect(pending.attempt("provider-multi", async () =>
      adapterInboundResultDisposition({
        ok: true,
        challenge: {
          deliveryId: "challenge-multi",
          code: "CODE",
          prompt: "Link this account",
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
        reply: { deliveryId: "reply-multi", text: "Reply too" },
      }, {
        surface: { kind: "dm", id: "chat-multi" },
        providerMessageId: "provider-multi",
      }), send)).resolves.toEqual({
      state: "pending",
      error: "challenge unavailable",
    });
    expect(send.mock.calls.map(([message]) => message.deliveryId)).toEqual([
      "challenge-multi",
      "reply-multi",
    ]);
  });

  it("drops an expired link challenge without calling the provider", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    const send = vi.fn(async () => ({ ok: true as const }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pending.enqueueAndArm("provider-7", { providerMessageId: "provider-7" }, 100);

    try {
      await expect(pending.attempt("provider-7", async () =>
        adapterInboundResultDisposition({
          ok: true,
          challenge: {
            deliveryId: "sensitive-challenge-id",
            code: "SENSITIVE-CODE",
            prompt: "Link this account",
            expiresAt: 0,
          },
        }, {
          surface: { kind: "dm", id: "chat-7" },
          providerMessageId: "provider-7",
        }), send)).resolves.toEqual({ state: "completed" });
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(JSON.stringify({
        component: "adapter",
        event: "inbound_response_expired",
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SENSITIVE");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not log provider error details for a terminal response rejection", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await pending.enqueueAndArm("provider-private-error", {
      providerMessageId: "provider-private-error",
    }, 100);

    try {
      await expect(pending.attempt("provider-private-error", async () =>
        adapterInboundResultDisposition({
          ok: true,
          reply: { deliveryId: "private-reply-id", text: "Reply" },
        }, {
          surface: { kind: "dm", id: "private-chat-id" },
          providerMessageId: "provider-private-error",
        }), async () => ({
          ok: false as const,
          error: "authorization: Bearer private-token",
        }))).resolves.toEqual({ state: "completed" });
      expect(warn).toHaveBeenCalledWith(JSON.stringify({
        component: "adapter",
        event: "inbound_response_rejected",
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not exceed ten response attempts after a cleanup crash", async () => {
    const storage = new MemoryStorage();
    const pending = ledger(storage);
    const enterKernel = vi.fn(async () => adapterInboundResultDisposition({
      ok: true,
      reply: { deliveryId: "reply-8", text: "Bounded retry" },
    }, {
      surface: { kind: "dm", id: "chat-8" },
      providerMessageId: "provider-8",
    }));
    const send = vi.fn(async () => ({
      ok: false as const,
      error: "provider unavailable",
      retryable: true,
    }));
    await pending.enqueueAndArm("provider-8", { providerMessageId: "provider-8" }, 100);

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await expect(pending.attempt("provider-8", enterKernel, send)).resolves.toEqual(
        { state: "pending", error: "provider unavailable" },
      );
    }
    storage.failNextDelete = true;
    await expect(pending.attempt("provider-8", enterKernel, send))
      .rejects.toThrow("simulated crash before local acknowledgement");

    const restarted = ledger(storage);
    await expect(restarted.attempt("provider-8", enterKernel, send)).resolves.toEqual({
      state: "completed",
    });
    expect(enterKernel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(10);
    await expect(restarted.pendingIds()).resolves.toEqual([]);
  });
});

describe("adapterInboundResultDisposition", () => {
  it("normalizes stable response ids and challenge expiry", () => {
    const surface = { kind: "dm" as const, id: "chat-1" };

    expect(adapterInboundResultDisposition({
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
      actorId: "provider:actor-1",
    })).toEqual({
      terminal: true,
      responses: [
        {
          message: {
            deliveryId: "challenge-1",
            surface,
            actorId: "provider:actor-1",
            text: "Link this account",
            replyToId: "provider-1",
          },
          expiresAt: 123,
        },
        {
          message: {
            deliveryId: "reply-1",
            surface,
            actorId: "provider:actor-1",
            text: "Done",
            replyToId: "provider-1",
          },
        },
      ],
    });
    expect(adapterInboundResultDisposition({
      ok: true,
      reply: { deliveryId: "reply-2", text: "Done" },
    }, {
      surface: { kind: "dm", id: "chat-2" },
      providerMessageId: "provider-2",
    }).responses?.[0]?.message).not.toHaveProperty("actorId");
  });
});
