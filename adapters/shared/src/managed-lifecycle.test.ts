import { describe, expect, it } from "vitest";
import {
  MANAGED_LIFECYCLE_STORAGE_KEY,
  ManagedLifecycleFence,
  describeManagedAdapterAccounts,
  normalizeManagedAccountIds,
  runManagedLifecycleAction,
  type ManagedLifecycleAccountStub,
  type ManagedLifecycleInventory,
  type ManagedLifecycleStatus,
} from "./managed-lifecycle";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, value);
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, entryValue);
    }
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map(this.values);
  }

  async transaction<T>(
    operation: (transaction: {
      delete(keys: string[]): Promise<number>;
      put(entries: Record<string, unknown>): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const snapshot = new Map(this.values);
    try {
      return await operation({
        delete: async (keys) => {
          let deleted = 0;
          for (const key of keys) {
            if (this.values.delete(key)) deleted += 1;
          }
          return deleted;
        },
        put: async (entries) => {
          for (const [key, value] of Object.entries(entries)) {
            this.values.set(key, value);
          }
        },
      });
    } catch (error) {
      this.values.clear();
      for (const [key, value] of snapshot) this.values.set(key, value);
      throw error;
    }
  }
}

function fence(storage: MemoryStorage): ManagedLifecycleFence {
  return new ManagedLifecycleFence(storage as DurableObjectStorage);
}

describe("ManagedLifecycleFence", () => {
  it("persists epochs across restarts and rejects a late active generation", async () => {
    const storage = new MemoryStorage();
    const first = fence(storage);
    await first.load();
    const originalEpoch = first.activeEpoch();

    await first.pause();
    expect(first.isActive(originalEpoch)).toBe(false);

    const restarted = fence(storage);
    await restarted.load();
    expect(restarted.snapshot("primary")).toMatchObject({
      accountId: "primary",
      status: "paused",
      epoch: 1,
    });

    await restarted.resume();
    expect(restarted.activeEpoch()).toBe(2);
    expect(restarted.isActive(originalEpoch)).toBe(false);
  });

  it("retains only an erased tombstone and cannot be resumed after restart", async () => {
    const storage = new MemoryStorage();
    await storage.put("credential", "secret");
    await storage.put("pending:event", { id: 1 });
    const first = fence(storage);
    await first.load();
    await first.erase();
    await first.eraseStorage({ accountId: "primary" });

    expect(storage.values).toEqual(
      new Map([
        [MANAGED_LIFECYCLE_STORAGE_KEY, expect.objectContaining({ status: "erased" })],
        ["accountId", "primary"],
      ]),
    );

    const restarted = fence(storage);
    await restarted.load();
    await expect(restarted.resume()).rejects.toThrow("erased");
  });

  it("serializes lifecycle cleanup across concurrent calls", async () => {
    const storage = new MemoryStorage();
    const lifecycle = fence(storage);
    await lifecycle.load();
    const order: string[] = [];
    let releaseFirst = (): void => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lifecycle.runExclusive(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = lifecycle.runExclusive(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});

describe("managed lifecycle fleet RPC", () => {
  it("accepts provider-style account IDs and rejects unsafe identities", () => {
    expect(normalizeManagedAccountIds([
      " 15551234567:4@s.whatsapp.net/device ",
      "bot:123456789/production",
      "telegram/アカウント",
    ])).toEqual([
      "15551234567:4@s.whatsapp.net/device",
      "bot:123456789/production",
      "telegram/アカウント",
    ]);

    expect(() => normalizeManagedAccountIds(["account\u0000id"])).toThrow(
      "account ID is invalid",
    );
    expect(() => normalizeManagedAccountIds(["x".repeat(257)])).toThrow(
      "account ID is invalid",
    );
  });

  it("normalizes IDs, bounds concurrency, and verifies every account", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const invoked: string[] = [];
    const stub = (accountId: string): ManagedLifecycleAccountStub => ({
      managedPause: () => transition(accountId, "paused"),
      managedResume: () => transition(accountId, "active"),
      managedErase: () => transition(accountId, "erased"),
    });
    const transition = async (
      accountId: string,
      status: ManagedLifecycleStatus,
    ): Promise<ManagedLifecycleInventory> => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      invoked.push(accountId);
      inFlight -= 1;
      return { accountId, status, epoch: 1, updatedAt: Date.now() };
    };

    const ids = Array.from({ length: 20 }, (_, index) => `account-${index}`);
    const result = await runManagedLifecycleAction(
      [...ids, " account-1 "],
      "managedPause",
      stub,
    );

    expect(result.accountIds).toEqual(normalizeManagedAccountIds(ids));
    expect(invoked.sort()).toEqual(result.accountIds);
    expect(maximumInFlight).toBeLessThanOrEqual(8);
  });

  it("does not confirm an account with mismatched inventory", async () => {
    const stub: ManagedLifecycleAccountStub = {
      managedPause: async () => ({
        accountId: "different",
        status: "paused",
        epoch: 1,
        updatedAt: Date.now(),
      }),
      managedResume: async () => {
        throw new Error("not used");
      },
      managedErase: async () => {
        throw new Error("not used");
      },
    };

    await expect(
      runManagedLifecycleAction(["primary"], "managedPause", () => stub),
    ).rejects.toThrow("invalid paused inventory");
  });

  it("dispatches provider IDs exactly and retains unknown account objects", async () => {
    const providerId = "a".repeat(64);
    const namespace = {
      idFromString: (value: string) => ({ toString: () => value }),
      idFromName: (value: string) => ({ toString: () => `named:${value}` }),
      get: () => ({
        managedPause: async () => { throw new Error("not used"); },
        managedResume: async () => { throw new Error("not used"); },
        managedErase: async () => { throw new Error("not used"); },
        managedDescriptor: async () => ({
          schemaVersion: 1 as const,
          kind: "adapter_account" as const,
          providerId,
          logicalName: null,
          classification: "uninitialized" as const,
          lifecycle: { status: "uninitialized" as const, epoch: 0 },
        }),
      }),
    };

    await expect(describeManagedAdapterAccounts(
      namespace as never,
      [providerId],
    )).resolves.toEqual({
      schemaVersion: 1,
      kind: "adapter_account",
      objects: [{
        schemaVersion: 1,
        kind: "adapter_account",
        providerId,
        logicalName: null,
        classification: "uninitialized",
        lifecycle: { status: "uninitialized", epoch: 0 },
      }],
    });
  });

  it("rejects adapter logical names that do not reproduce the provider ID", async () => {
    const providerId = "b".repeat(64);
    const namespace = {
      idFromString: (value: string) => ({ toString: () => value }),
      idFromName: () => ({ toString: () => "c".repeat(64) }),
      get: () => ({
        managedPause: async () => { throw new Error("not used"); },
        managedResume: async () => { throw new Error("not used"); },
        managedErase: async () => { throw new Error("not used"); },
        managedDescriptor: async () => ({
          schemaVersion: 1 as const,
          kind: "adapter_account" as const,
          providerId,
          logicalName: "primary",
          classification: "initialized" as const,
          lifecycle: { status: "active" as const, epoch: 0 },
        }),
      }),
    };

    await expect(describeManagedAdapterAccounts(
      namespace as never,
      [providerId],
    )).rejects.toThrow("logical identity");
  });
});
