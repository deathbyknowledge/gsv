import { describe, expect, it } from "vitest";

import {
  clearAuthState,
  hasAuthState,
  useDOAuthState,
} from "../src/auth-store";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
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
    let resolve!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((done) => {
      resolve = done;
    });
    await previous;
    try {
      return await operation(this);
    } finally {
      resolve();
    }
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
    await oldAuth.saveCreds();
    await oldAuth.state.keys.set({
      session: { stale: { value: "stale" } as never },
    });

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

  it("clears stale Signal keys when stored credentials are corrupt", async () => {
    const storage = new MemoryStorage();
    storage.values.set("auth:creds", "not-json");
    storage.values.set("signal:session:stale", "serialized-stale-key");

    const auth = await useDOAuthState(storage as unknown as DurableObjectStorage);

    expect(auth.authReset).toBe(true);
    expect(auth.state.creds.registered).toBe(false);
    expect(storage.values.has("auth:creds")).toBe(false);
    expect(storage.values.has("signal:session:stale")).toBe(false);
    expect(storage.values.get("auth:epoch")).toBe(1);
  });
});
