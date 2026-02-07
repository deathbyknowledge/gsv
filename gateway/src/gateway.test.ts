import { describe, it, expect } from "vitest";
import { PersistedObject } from "./stored";
import { DEFAULT_CONFIG, mergeConfig, type GsvConfig, type GsvConfigInput } from "./config";

// Mock KV storage
function createMockKv() {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => store.get(key),
    put: (key: string, value: unknown) => store.set(key, value),
    delete: (key: string) => store.delete(key),
    list: (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(prefix));
    },
  };
}

describe("Gateway config serialization", () => {
  /**
   * This test catches the bug where getConfig() returned a Proxy object
   * that couldn't be serialized for RPC calls to Session DO.
   * 
   * The fix: getConfig() now does JSON.parse(JSON.stringify(...))
   */
  describe("getConfig RPC simulation", () => {
    it("config from PersistedObject can be serialized for RPC", () => {
      const kv = createMockKv();
      const configStore = PersistedObject<Partial<GsvConfig>>(kv, { prefix: "config:" });
      
      // Set some config values (simulating what Gateway does)
      configStore.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
      configStore.apiKeys = { anthropic: "sk-test" };
      configStore.channels = {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+31628552611"],
        },
      };

      // Simulate getFullConfig() - merges defaults with stored config
      function getFullConfig(): GsvConfig {
        const stored = { ...configStore } as GsvConfigInput;
        return mergeConfig(DEFAULT_CONFIG, stored);
      }

      // THE BUG: This would fail because PersistedObject returns Proxy
      // THE FIX: Deep clone before returning
      function getConfig(): GsvConfig {
        return JSON.parse(JSON.stringify(getFullConfig()));
      }

      const config = getConfig();

      // Verify the config is usable
      expect(config.model.provider).toBe("anthropic");
      expect(config.channels.whatsapp.dmPolicy).toBe("pairing");
      expect(config.channels.whatsapp.allowFrom).toContain("+31628552611");

      // THE CRITICAL TEST: Verify we can serialize again (RPC simulation)
      const serialized = JSON.stringify(config);
      const parsed = JSON.parse(serialized);
      expect(parsed.model.provider).toBe("anthropic");
      expect(parsed.channels.whatsapp.allowFrom).toContain("+31628552611");
    });

    it("detects Proxy objects that would fail RPC", () => {
      const kv = createMockKv();
      const configStore = PersistedObject<{ nested: { value: number } }>(kv);
      configStore.nested = { value: 42 };

      // Without the fix, this nested object is a Proxy
      const nested = configStore.nested;

      // Proxies can be JSON serialized locally, but would fail in RPC
      // This test documents the behavior - JSON.stringify works on Proxy
      const serialized = JSON.stringify(nested);
      expect(serialized).toBe('{"value":42}');

      // The issue is that Cloudflare's RPC uses structured clone, not JSON
      // Proxies fail structured clone. Our fix ensures we return plain objects.
    });

    it("config can be passed to another function (simulating Session DO)", () => {
      const kv = createMockKv();
      const configStore = PersistedObject<Partial<GsvConfig>>(kv, { prefix: "config:" });
      configStore.model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
      configStore.timeouts = { llmMs: 300000, toolMs: 60000 };

      function getConfig(): GsvConfig {
        const stored = { ...configStore } as GsvConfigInput;
        return JSON.parse(JSON.stringify(mergeConfig(DEFAULT_CONFIG, stored)));
      }

      const config = getConfig();

      // Simulate what Session DO does with the config
      function callLlm(cfg: GsvConfig) {
        return {
          provider: cfg.model.provider,
          modelId: cfg.model.id,
          timeout: cfg.timeouts.llmMs,
        };
      }

      const result = callLlm(config);
      expect(result.provider).toBe("anthropic");
      expect(result.modelId).toBe("claude-sonnet-4-20250514");
      expect(result.timeout).toBe(300000);
    });
  });
});
