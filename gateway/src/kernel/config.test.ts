import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "./config";

type Row = Record<string, unknown>;

function createMockSql() {
  const tables = new Map<string, Row[]>();

  function getTable(name: string): Row[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function exec<T = Row>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    if (q.startsWith("CREATE TABLE IF NOT EXISTS")) {
      const match = q.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      if (match) getTable(match[1]);
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR REPLACE INTO config_kv")) {
      const table = getTable("config_kv");
      const [key, value] = bindings as [string, string];
      const idx = table.findIndex((row) => row.key === key);
      if (idx >= 0) {
        table[idx] = { key, value };
      } else {
        table.push({ key, value });
      }
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT OR IGNORE INTO config_kv")) {
      const table = getTable("config_kv");
      const [key, value] = bindings as [string, string];
      const exists = table.some((row) => row.key === key);
      if (!exists) table.push({ key, value });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT value FROM config_kv WHERE key = ?")) {
      const table = getTable("config_kv");
      const [key] = bindings as [string];
      const row = table.find((record) => record.key === key);
      const rows = row ? [{ value: row.value as string }] : [];
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("DELETE FROM config_kv WHERE key = ?")) {
      const table = getTable("config_kv");
      const [key] = bindings as [string];
      const idx = table.findIndex((record) => record.key === key);
      if (idx >= 0) table.splice(idx, 1);
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT key, value FROM config_kv WHERE key LIKE ? ORDER BY key")) {
      const table = getTable("config_kv");
      const [pattern] = bindings as [string];
      const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
      const rows = table
        .filter((record) => String(record.key).startsWith(prefix))
        .map((record) => ({
          key: String(record.key),
          value: String(record.value),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { toArray: () => rows as T[] };
    }

    if (q.startsWith("SELECT key, value FROM config_kv ORDER BY key")) {
      const table = getTable("config_kv");
      const rows = table
        .map((record) => ({
          key: String(record.key),
          value: String(record.value),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return { toArray: () => rows as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec } as SqlStorage;
}

describe("ConfigStore", () => {
  let store: ConfigStore;

  beforeEach(() => {
    const sql = createMockSql();
    store = new ConfigStore(sql);
    store.init();
    store.set("config/ai/provider", "anthropic");
    store.set("config/ai/model", "claude-sonnet-4-20250514");
    store.set("users/0/ai/model", "gpt-4.1");
  });

  it("list(\"\") returns all keys", () => {
    const all = store.list("");
    expect(all.length).toBe(3);
    expect(all.map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "config/ai/provider",
      "users/0/ai/model",
    ]);
  });

  it("list(prefix) returns only matching subtree", () => {
    const ai = store.list("config/ai");
    expect(ai.map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "config/ai/provider",
    ]);
  });

  it("list(prefix with trailing slash) behaves the same", () => {
    const ai = store.list("config/ai/");
    expect(ai.map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "config/ai/provider",
    ]);
  });
});
