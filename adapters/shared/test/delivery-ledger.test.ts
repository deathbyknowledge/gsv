import { describe, expect, it } from "vitest";

import {
  classifyNonIdempotentProviderStatus,
  DeliveryLedger,
  fingerprintOutboundDelivery,
} from "../src/delivery-ledger";

const REQUEST_FINGERPRINT = "a".repeat(64);
const OTHER_REQUEST_FINGERPRINT = "b".repeat(64);

class MemoryTransaction {
  constructor(private readonly values: Map<string, unknown>) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix));
    return new Map(entries) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce(
        (deleted, item) => deleted + (this.values.delete(item) ? 1 : 0),
        0,
      );
    }
    return this.values.delete(key);
  }
}

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async transaction<T>(
    closure: (txn: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    return await closure(new MemoryTransaction(this.values));
  }
}

function memoryLedger(options: ConstructorParameters<typeof DeliveryLedger>[1] = {}) {
  const storage = new MemoryStorage();
  return new DeliveryLedger(
    storage as unknown as DurableObjectStorage,
    options,
  );
}

describe("DeliveryLedger", () => {
  it("returns the original durable success without sending again", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-1", REQUEST_FINGERPRINT);
    expect(first.claimed).toBe(true);
    if (!first.claimed) throw new Error("expected a delivery claim");

    await ledger.succeed("delivery-1", first.attemptId, "provider-message-1");

    await expect(ledger.claim("delivery-1", REQUEST_FINGERPRINT)).resolves.toEqual({
      claimed: false,
      result: {
        ok: true,
        messageId: "provider-message-1",
        deduplicated: true,
      },
    });
  });

  it("releases a definitely rejected attempt for a safe retry", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-2", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");

    await ledger.releaseRetryable("delivery-2", first.attemptId);
    const retry = await ledger.claim("delivery-2", REQUEST_FINGERPRINT);

    expect(retry.claimed).toBe(true);
    if (!retry.claimed) throw new Error("expected a retry claim");
    expect(retry.attemptId).not.toBe(first.attemptId);
  });

  it("never reclaims an in-flight or ambiguous provider attempt", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-3", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");

    const concurrent = await ledger.claim("delivery-3", REQUEST_FINGERPRINT);
    expect(concurrent).toMatchObject({
      claimed: false,
      result: { ok: false, ambiguous: true },
    });

    await ledger.failAmbiguous(
      "delivery-3",
      first.attemptId,
      "provider outcome unknown",
    );
    await expect(ledger.claim("delivery-3", REQUEST_FINGERPRINT)).resolves.toEqual({
      claimed: false,
      result: {
        ok: false,
        error: "provider outcome unknown",
        ambiguous: true,
      },
    });
  });

  it("caches permanent validation or authentication failures", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-permanent", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");

    await ledger.failPermanent(
      "delivery-permanent",
      first.attemptId,
      "provider rejected credentials",
    );
    await expect(ledger.claim("delivery-permanent", REQUEST_FINGERPRINT)).resolves.toEqual({
      claimed: false,
      result: {
        ok: false,
        error: "provider rejected credentials",
      },
    });
  });

  it("preserves unexpired records at capacity and prunes them after expiry", async () => {
    let now = 1000;
    const ledger = memoryLedger({
      maxRecords: 1,
      retentionMs: 100,
      pruneIntervalMs: 1000,
      now: () => now,
    });
    const first = await ledger.claim("delivery-4", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");
    await ledger.succeed("delivery-4", first.attemptId, "provider-message-4");

    await expect(ledger.claim("delivery-5", REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: false,
      result: { ok: false, retryable: true },
    });

    now += 101;
    await expect(ledger.claim("delivery-5", REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: true,
    });
  });

  it("does not let a stale attempt overwrite a newer retry", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-6", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");
    await ledger.releaseRetryable("delivery-6", first.attemptId);

    const second = await ledger.claim("delivery-6", REQUEST_FINGERPRINT);
    if (!second.claimed) throw new Error("expected a retry claim");
    await ledger.succeed("delivery-6", first.attemptId, "stale-message");

    await expect(ledger.claim("delivery-6", REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: false,
      result: { ok: false, ambiguous: true },
    });
  });

  it("enforces the gateway delivery ID boundary", async () => {
    const ledger = memoryLedger();

    await expect(ledger.claim("a".repeat(200), REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: true,
    });
    await expect(ledger.claim("a".repeat(201), REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: false,
      result: { ok: false },
    });
    await expect(ledger.claim("contains spaces", REQUEST_FINGERPRINT)).resolves.toMatchObject({
      claimed: false,
      result: { ok: false },
    });
  });

  it("rejects reusing a delivery id for a different logical request", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-bound", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");
    await ledger.succeed("delivery-bound", first.attemptId, "provider-message");

    await expect(
      ledger.claim("delivery-bound", OTHER_REQUEST_FINGERPRINT),
    ).resolves.toEqual({
      claimed: false,
      result: {
        ok: false,
        error: "deliveryId is already bound to a different outbound destination or content",
      },
    });
  });

  it("keeps the request binding across a retryable rejection", async () => {
    const ledger = memoryLedger();
    const first = await ledger.claim("delivery-retry-bound", REQUEST_FINGERPRINT);
    if (!first.claimed) throw new Error("expected a delivery claim");
    await ledger.releaseRetryable("delivery-retry-bound", first.attemptId);

    await expect(
      ledger.claim("delivery-retry-bound", OTHER_REQUEST_FINGERPRINT),
    ).resolves.toMatchObject({
      claimed: false,
      result: { ok: false, error: expect.stringContaining("already bound") },
    });
    await expect(
      ledger.claim("delivery-retry-bound", REQUEST_FINGERPRINT),
    ).resolves.toMatchObject({ claimed: true });
  });

  it("fingerprints destination, text, and binary media content", async () => {
    const base = {
      surface: { kind: "dm" as const, id: "chat-1" },
      text: "hello",
      media: [{
        type: "document" as const,
        mimeType: "application/octet-stream",
        filename: "data.bin",
        body: { offset: 0, length: 3 },
      }],
    };
    const fingerprint = await fingerprintOutboundDelivery(
      base,
      [new Uint8Array([1, 2, 3])],
    );

    await expect(fingerprintOutboundDelivery(
      { ...base, text: "different" },
      [new Uint8Array([1, 2, 3])],
    )).resolves.not.toBe(fingerprint);
    await expect(fingerprintOutboundDelivery(
      { ...base, surface: { kind: "dm", id: "chat-2" } },
      [new Uint8Array([1, 2, 3])],
    )).resolves.not.toBe(fingerprint);
    await expect(fingerprintOutboundDelivery(
      base,
      [new Uint8Array([1, 2, 4])],
    )).resolves.not.toBe(fingerprint);
  });
});

describe("non-idempotent provider status classification", () => {
  it("retries only a definite rate-limit rejection", () => {
    expect(classifyNonIdempotentProviderStatus(429)).toBe("retryable");
    expect(classifyNonIdempotentProviderStatus(408)).toBe("ambiguous");
    expect(classifyNonIdempotentProviderStatus(500)).toBe("ambiguous");
    expect(classifyNonIdempotentProviderStatus(503)).toBe("ambiguous");
  });

  it("treats authentication and validation responses as permanent", () => {
    expect(classifyNonIdempotentProviderStatus(400)).toBe("permanent");
    expect(classifyNonIdempotentProviderStatus(401)).toBe("permanent");
    expect(classifyNonIdempotentProviderStatus(403)).toBe("permanent");
  });
});
