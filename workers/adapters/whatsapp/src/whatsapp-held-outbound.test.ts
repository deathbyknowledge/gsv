import { describe, expect, it } from "vitest";

import {
  HELD_OUTBOUND_MAX_TEXT,
  HELD_OUTBOUND_PREFIX,
  HELD_OUTBOUND_RETENTION_MS,
  WhatsAppHeldOutbound,
  type HeldOutboundRecord,
} from "./whatsapp-held-outbound";

type StoredValue = HeldOutboundRecord;

class MemoryTransaction {
  constructor(private readonly values: Map<string, StoredValue>) {}

  async get<T>(key: string): Promise<T | undefined> {
    // SAFETY: This test fixture deliberately supplies the contract shape under test.
    return this.values.get(key) as T | undefined;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix));
    // SAFETY: This test fixture deliberately supplies the contract shape under test.
    return new Map(entries) as Map<string, T>;
  }

  async put<T>(key: string, value: T): Promise<void> {
    // SAFETY: This test fixture deliberately supplies the contract shape under test.
    this.values.set(key, value as StoredValue);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      return key.reduce((deleted, item) => deleted + (this.values.delete(item) ? 1 : 0), 0);
    }
    return this.values.delete(key);
  }
}

class MemoryStorage {
  readonly values = new Map<string, StoredValue>();

  async transaction<T>(closure: (txn: MemoryTransaction) => Promise<T>): Promise<T> {
    return await closure(new MemoryTransaction(this.values));
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return await new MemoryTransaction(this.values).list<T>(options);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    return await new MemoryTransaction(this.values).delete(key);
  }
}

const OWNER = { installationId: "installation-a", generation: "generation-1" };
const OTHER_GENERATION = { installationId: "installation-a", generation: "generation-2" };
const OTHER_INSTALLATION = { installationId: "installation-b", generation: "generation-9" };

function heldStore(options: { maxRecords?: number } = {}) {
  const storage = new MemoryStorage();
  let now = 1_700_000_000_000;
  const held = new WhatsAppHeldOutbound(
    // SAFETY: This test fixture deliberately supplies the contract shape under test.
    storage as DurableObjectStorage,
    { ...options, now: () => now },
  );
  return { storage, held, advance: (ms: number) => { now += ms; } };
}

describe("WhatsAppHeldOutbound", () => {
  it("holds messages in order for one route, deduplicates by delivery id and removes on release", async () => {
    const { held, storage } = heldStore();
    const first = await held.hold({ deliveryId: "reply-1", owner: OWNER, markdown: "first", replyToId: "wamid.in" });
    expect(first).toMatchObject({ held: true, record: { sequence: 1, replyToId: "wamid.in" } });
    await held.hold({ deliveryId: "reply-2", owner: OWNER, markdown: "second" });
    expect(await held.hold({ deliveryId: "reply-1", owner: OWNER, markdown: "first again" }))
      .toMatchObject({ held: false, reason: "duplicate", record: { markdown: "first" } });
    expect([...storage.values.keys()].every((key) => key.startsWith(HELD_OUTBOUND_PREFIX))).toBe(true);

    expect((await held.list(OWNER)).map((record) => record.deliveryId)).toEqual(["reply-1", "reply-2"]);
    expect(await held.list(OTHER_GENERATION)).toEqual([]);
    await held.remove("reply-1");
    expect((await held.list(OWNER)).map((record) => record.deliveryId)).toEqual(["reply-2"]);
  });

  it("drops held messages once their retention has passed", async () => {
    const { held, storage, advance } = heldStore();
    await held.hold({ deliveryId: "reply-1", owner: OWNER, markdown: "first" });
    advance(HELD_OUTBOUND_RETENTION_MS - 1);
    expect(await held.list(OWNER)).toHaveLength(1);
    advance(1);
    expect(await held.list(OWNER)).toEqual([]);
    expect(storage.values.size).toBe(0);
  });

  it("refuses to hold past the queue cap or a message too long to store", async () => {
    const { held } = heldStore({ maxRecords: 2 });
    await held.hold({ deliveryId: "reply-1", owner: OWNER, markdown: "first" });
    await held.hold({ deliveryId: "reply-2", owner: OWNER, markdown: "second" });
    expect(await held.hold({ deliveryId: "reply-3", owner: OWNER, markdown: "third" }))
      .toEqual({ held: false, reason: "full" });
    expect(await held.hold({ deliveryId: "reply-4", owner: OWNER, markdown: "x".repeat(HELD_OUTBOUND_MAX_TEXT + 1) }))
      .toEqual({ held: false, reason: "too-long" });
  });

  it("reports and erases records by installation for retirement", async () => {
    const { held, storage } = heldStore();
    await held.hold({ deliveryId: "reply-1", owner: OWNER, markdown: "first" });
    await held.hold({ deliveryId: "reply-2", owner: OTHER_INSTALLATION, markdown: "other" });
    expect(await held.inspectOwnership("installation-a")).toEqual({
      installationIds: ["installation-a", "installation-b"],
      unattributed: 0,
      ownedCount: 1,
    });
    expect(await held.eraseInstallation("installation-a")).toBe(0);
    expect(storage.values.size).toBe(1);
    expect((await held.list(OTHER_INSTALLATION)).map((record) => record.deliveryId)).toEqual(["reply-2"]);
  });
});
