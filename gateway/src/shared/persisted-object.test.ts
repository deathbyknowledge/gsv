import { describe, it, expect, beforeEach } from "vitest";
import { PersistedObject, snapshot } from "./persisted-object";

// Mock KV storage that behaves like DO storage.kv
function createMockKv() {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => store.set(key, value),
    delete: (key: string) => store.delete(key),
    list: (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k, v]);
    },
  };
}

describe("PersistedObject", () => {
  let kv: ReturnType<typeof createMockKv>;

  beforeEach(() => {
    kv = createMockKv();
  });

  describe("basic operations", () => {
    it("stores and retrieves primitive values", () => {
      const obj = PersistedObject<{ name: string; count: number }>(kv);
      obj.name = "test";
      obj.count = 42;

      expect(obj.name).toBe("test");
      expect(obj.count).toBe(42);
    });

    it("stores and retrieves objects", () => {
      const obj = PersistedObject<{ config: { a: number; b: string } }>(kv);
      obj.config = { a: 1, b: "hello" };

      expect(obj.config.a).toBe(1);
      expect(obj.config.b).toBe("hello");
    });

    it("stores and retrieves arrays", () => {
      const obj = PersistedObject<{ items: string[] }>(kv);
      obj.items = ["a", "b", "c"];

      expect(obj.items).toEqual(["a", "b", "c"]);
    });
  });

  describe("serialization (THE BUG WE FIXED)", () => {
    it("values can be JSON serialized", () => {
      const obj = PersistedObject<{
        config: { model: { provider: string; id: string } };
        items: string[];
      }>(kv);

      obj.config = { model: { provider: "anthropic", id: "claude-3" } };
      obj.items = ["a", "b"];

      // This is the critical test - the Proxy bug would fail here
      // because JSON.stringify can't serialize Proxy objects for RPC
      const serialized = JSON.stringify(obj.config);
      const parsed = JSON.parse(serialized);

      expect(parsed).toEqual({ model: { provider: "anthropic", id: "claude-3" } });
    });

    it("nested objects can be JSON serialized", () => {
      const obj = PersistedObject<{
        deep: { level1: { level2: { value: string } } };
      }>(kv);

      obj.deep = { level1: { level2: { value: "nested" } } };

      // Access nested value (creates wrapped proxy)
      const level1 = obj.deep.level1;

      // Serialize the nested proxy
      const serialized = JSON.stringify(level1);
      const parsed = JSON.parse(serialized);

      expect(parsed).toEqual({ level2: { value: "nested" } });
    });

    it("entire object can be spread and serialized", () => {
      const obj = PersistedObject<{
        a: number;
        b: string;
        c: { nested: boolean };
      }>(kv);

      obj.a = 1;
      obj.b = "test";
      obj.c = { nested: true };

      // Spread into plain object and serialize
      // This pattern is used in getConfig() to avoid RPC serialization issues
      const plain = JSON.parse(JSON.stringify({ a: obj.a, b: obj.b, c: obj.c }));

      expect(plain).toEqual({ a: 1, b: "test", c: { nested: true } });
    });
  });

  describe("auto-save mutations", () => {
    it("persists array push operations", () => {
      const obj = PersistedObject<{ items: string[] }>(kv);
      obj.items = ["a"];
      obj.items.push("b");

      // Verify it was saved to KV
      expect(kv.get("items")).toEqual(["a", "b"]);
    });

    it("persists nested object mutations", () => {
      const obj = PersistedObject<{ config: { value: number } }>(kv);
      obj.config = { value: 1 };
      obj.config.value = 2;

      // Verify mutation was saved
      expect((kv.get("config") as { value: number }).value).toBe(2);
    });
  });

  describe("defaults", () => {
    it("returns default values for missing keys", () => {
      const obj = PersistedObject<{ count: number }>(kv, {
        defaults: { count: 100 },
      });

      expect(obj.count).toBe(100);
    });

    it("stored values override defaults", () => {
      kv.put("count", 42);
      const obj = PersistedObject<{ count: number }>(kv, {
        defaults: { count: 100 },
      });

      expect(obj.count).toBe(42);
    });
  });

  describe("prefix", () => {
    it("uses prefix for all keys", () => {
      const obj = PersistedObject<{ name: string }>(kv, { prefix: "user:" });
      obj.name = "test";

      expect(kv.get("user:name")).toBe("test");
      expect(kv.get("name")).toBeUndefined();
    });
  });

  describe("snapshot()", () => {
    it("returns a plain deep-cloned object", () => {
      const obj = PersistedObject<{
        config: { nested: { value: number }; items: string[] };
      }>(kv);
      obj.config = { nested: { value: 42 }, items: ["a", "b"] };

      const plain = snapshot(obj);

      expect(plain.config.nested.value).toBe(42);
      expect(plain.config.items).toEqual(["a", "b"]);

      // Mutations on the snapshot must NOT affect the original
      plain.config.nested.value = 999;
      plain.config.items.push("c");
      expect(obj.config.nested.value).toBe(42);
      expect(obj.config.items).toEqual(["a", "b"]);
    });

    it("snapshot is structuredClone-safe (no Proxy wrappers)", () => {
      const obj = PersistedObject<{
        channels: Record<string, { policy: string; allowFrom: string[] }>;
      }>(kv);
      obj.channels = {
        whatsapp: { policy: "pairing", allowFrom: ["+31628552611"] },
      };

      const plain = snapshot(obj);

      // Verify the snapshot can round-trip through JSON (proxy-free)
      const roundTripped = JSON.parse(JSON.stringify(plain));
      expect(roundTripped.channels.whatsapp.policy).toBe("pairing");
      expect(roundTripped.channels.whatsapp.allowFrom).toContain("+31628552611");
    });
  });
});
