import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";

import {
  clearAuthState,
  hasAuthState,
  hasRegisteredAuthState,
  useDOAuthState,
} from "../src/auth-store";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  transactionCalls = 0;
  largestGetBatch = 0;

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      if (key.length > 128) throw new RangeError("Storage get limit exceeded");
      this.largestGetBatch = Math.max(this.largestGetBatch, key.length);
      return new Map(key
        .filter((item) => this.values.has(item))
        .map((item) => [item, this.values.get(item) as T]));
    }
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put(entries: Record<string, unknown>): Promise<void>;
  async put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, value);
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, entryValue);
    }
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

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix)),
    ) as Map<string, T>;
  }

  async transaction<T>(operation: (txn: MemoryStorage) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    return await operation(this);
  }
}

describe("Durable Object WhatsApp auth", () => {
  it("fences stale credential and Signal writes after auth clear", async () => {
    const storage = new MemoryStorage();
    const oldAuth = await useDOAuthState(
      storage as unknown as DurableObjectStorage,
    );
    oldAuth.state.creds.registered = true;
    await oldAuth.saveCreds();
    await oldAuth.state.keys.set({
      session: { old: { value: "old" } as never },
    });
    expect(await hasAuthState(storage as unknown as DurableObjectStorage)).toBe(true);
    expect(storage.values.has("signal:session:old")).toBe(true);

    await clearAuthState(storage as unknown as DurableObjectStorage);
    await expect(oldAuth.saveCreds()).rejects.toThrow(
      "WhatsApp authentication state is stale",
    );
    await expect(oldAuth.state.keys.set({
      session: { stale: { value: "stale" } as never },
    })).rejects.toThrow("WhatsApp authentication state is stale");
    await expect(oldAuth.state.keys.get("session", ["old"]))
      .rejects.toThrow("WhatsApp authentication state is stale");
    await expect(oldAuth.state.keys.clear?.())
      .rejects.toThrow("WhatsApp authentication state is stale");

    expect(await hasAuthState(storage as unknown as DurableObjectStorage)).toBe(false);
    expect(storage.values.has("signal:session:old")).toBe(false);
    expect(storage.values.has("signal:session:stale")).toBe(false);
    const freshAuth = await useDOAuthState(
      storage as unknown as DurableObjectStorage,
    );
    await freshAuth.state.keys.set({
      session: { fresh: { value: "fresh" } as never },
    });
    expect(storage.values.has("signal:session:fresh")).toBe(true);
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["an invalid shape", JSON.stringify({ registered: true })],
  ])("clears stale Signal keys when credentials contain %s", async (_case, stored) => {
    const storage = new MemoryStorage();
    storage.values.set("auth:creds", stored);
    storage.values.set("signal:session:stale", "serialized-stale-key");

    expect(await hasRegisteredAuthState(
      storage as unknown as DurableObjectStorage,
    )).toBe(false);
    const auth = await useDOAuthState(storage as unknown as DurableObjectStorage);

    expect(auth.authReset).toBe(true);
    expect(auth.state.creds.registered).toBe(false);
    expect(storage.values.has("auth:creds")).toBe(false);
    expect(storage.values.has("signal:session:stale")).toBe(false);
    expect(storage.values.get("auth:epoch")).toBe(1);
  });

  it("round-trips valid credentials without resetting the account", async () => {
    const storage = new MemoryStorage();
    const auth = await useDOAuthState(storage as unknown as DurableObjectStorage);
    auth.state.creds.me = { id: "12025550123@s.whatsapp.net" };
    auth.state.creds.registered = true;
    await auth.saveCreds();

    expect(await hasRegisteredAuthState(
      storage as unknown as DurableObjectStorage,
    )).toBe(true);

    const restored = await useDOAuthState(
      storage as unknown as DurableObjectStorage,
    );
    expect(restored.authReset).toBe(false);
    expect(restored.state.creds.registered).toBe(true);
    expect(restored.state.creds.me?.id).toBe("12025550123@s.whatsapp.net");
  });

  it("merges credential changes from overlapping socket snapshots", async () => {
    const storage = new MemoryStorage();
    const seeded = await useDOAuthState(storage as unknown as DurableObjectStorage);
    seeded.state.creds.me = { id: "12025550123@s.whatsapp.net" };
    seeded.state.creds.registered = true;
    seeded.state.creds.accountSyncCounter = 1;
    seeded.state.creds.lastAccountSyncTimestamp = 100;
    await seeded.saveCreds();

    const active = await useDOAuthState(storage as unknown as DurableObjectStorage);
    const replacement = await useDOAuthState(storage as unknown as DurableObjectStorage);
    active.state.creds.accountSyncCounter = 2;
    await active.saveCreds();
    replacement.state.creds.lastAccountSyncTimestamp = 200;
    await replacement.saveCreds();

    const restored = await useDOAuthState(
      storage as unknown as DurableObjectStorage,
    );
    expect(restored.state.creds.accountSyncCounter).toBe(2);
    expect(restored.state.creds.lastAccountSyncTimestamp).toBe(200);
  });

  it("hydrates persisted app state keys as Baileys protobuf values", async () => {
    const storage = new MemoryStorage();
    const auth = await useDOAuthState(storage as unknown as DurableObjectStorage);
    const key = proto.Message.AppStateSyncKeyData.create({
      keyData: Buffer.from([1, 2, 3, 4]),
      fingerprint: {
        rawId: 7,
        currentIndex: 2,
        deviceIndexes: [0, 2],
      },
      timestamp: 42,
    });
    await auth.state.keys.set({
      "app-state-sync-key": { current: key },
    });

    const restored = await auth.state.keys.get(
      "app-state-sync-key",
      ["current"],
    );

    expect(restored.current).toBeInstanceOf(
      proto.Message.AppStateSyncKeyData,
    );
    expect(Buffer.from(restored.current.keyData ?? [])).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(restored.current.fingerprint?.deviceIndexes).toEqual([0, 2]);
  });

  it("reads Signal key batches larger than the storage limit atomically", async () => {
    const storage = new MemoryStorage();
    const auth = await useDOAuthState(storage as unknown as DurableObjectStorage);
    const ids = Array.from({ length: 129 }, (_, index) => `device-${index}`);
    await auth.state.keys.set({
      session: Object.fromEntries(
        ids.map((id, index) => [id, Buffer.from([index % 256])]),
      ),
    });
    storage.transactionCalls = 0;
    storage.largestGetBatch = 0;

    const restored = await auth.state.keys.get("session", ids);

    expect(Object.keys(restored)).toHaveLength(ids.length);
    expect(storage.transactionCalls).toBe(1);
    expect(storage.largestGetBatch).toBe(128);
  });
});
