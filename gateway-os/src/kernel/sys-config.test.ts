import { describe, expect, it } from "vitest";
import type { KernelContext } from "./context";
import { handleSysConfigGet } from "./sys-config";

type EntryMap = Record<string, string>;

function makeContext(uid: number, entries: EntryMap): KernelContext {
  const map = new Map(Object.entries(entries));
  const config = {
    get(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    list(prefix: string): { key: string; value: string }[] {
      const normalized = prefix.trim();
      const keys = [...map.keys()].sort();
      if (!normalized) {
        return keys.map((key) => ({ key, value: map.get(key)! }));
      }
      const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
      return keys
        .filter((key) => key.startsWith(withSlash))
        .map((key) => ({ key, value: map.get(key)! }));
    },
  };

  return {
    identity: {
      role: "user",
      process: {
        uid,
        gid: uid,
        gids: [uid],
        username: uid === 0 ? "root" : `user${uid}`,
        home: uid === 0 ? "/root" : `/home/user${uid}`,
        cwd: uid === 0 ? "/root" : `/home/user${uid}`,
        workspaceId: null,
      },
      capabilities: ["*"],
    },
    config: config as unknown as KernelContext["config"],
  } as KernelContext;
}

describe("sys.config.get", () => {
  const baseEntries: EntryMap = {
    "config/ai/provider": "openrouter",
    "config/ai/model": "qwen",
    "config/ai/api_key": "sk-live",
    "users/1000/ai/model": "qwen-user",
    "users/1001/ai/model": "other",
  };

  it("blocks non-root exact reads of sensitive system config", () => {
    const ctx = makeContext(1000, baseEntries);
    expect(() => handleSysConfigGet({ key: "config/ai/api_key" }, ctx)).toThrow(
      "Permission denied: cannot read config/ai/api_key",
    );
  });

  it("hides sensitive keys from non-root prefix listings", () => {
    const ctx = makeContext(1000, baseEntries);
    const result = handleSysConfigGet({ key: "config/ai" }, ctx);
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "config/ai/provider",
    ]);
  });

  it("allows root reads of sensitive system config", () => {
    const ctx = makeContext(0, baseEntries);
    const result = handleSysConfigGet({ key: "config/ai/api_key" }, ctx);
    expect(result.entries).toEqual([{ key: "config/ai/api_key", value: "sk-live" }]);
  });
});
