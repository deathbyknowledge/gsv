import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore, SYSTEM_CONFIG_DEFAULTS } from "./config";

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
    store.set("config/ai/provider", "anthropic");
    store.set("config/ai/model", "claude-sonnet-4-20250514");
    store.set("users/0/ai/model", "gpt-4.1");
  });

  it("get overlays defaults unless an explicit value is set", () => {
    expect(store.get("config/ai/api_key")).toBe("");
    expect(store.getExplicit("config/ai/api_key")).toBeNull();
    expect(store.get("config/ai/provider")).toBe("anthropic");
    expect(store.getExplicit("config/ai/provider")).toBe("anthropic");
  });

  it("delete removes explicit values and reveals defaults", () => {
    expect(store.delete("config/ai/provider")).toBe(true);
    expect(store.getExplicit("config/ai/provider")).toBeNull();
    expect(store.get("config/ai/provider")).toBe("workers-ai");
    expect(store.delete("config/ai/provider")).toBe(false);
  });

  it("listExplicit(\"\") returns only stored override keys", () => {
    const all = store.list("");
    expect(store.listExplicit("").map((entry) => entry.key)).toEqual([
      "config/ai/model",
      "config/ai/provider",
      "users/0/ai/model",
    ]);
    expect(all.length).toBeGreaterThan(3);
    expect(new Set(all.map((entry) => entry.key)).size).toBe(all.length);
  });

  it("list(prefix) merges defaults and explicit overrides", () => {
    const ai = store.list("config/ai");
    const values = new Map(ai.map((entry) => [entry.key, entry.value]));
    expect(values.get("config/ai/api_key")).toBe("");
    expect(values.get("config/ai/provider")).toBe("anthropic");
    expect(values.get("config/ai/model")).toBe("claude-sonnet-4-20250514");
    expect(values.get("config/ai/generation/streaming")).toBe("auto");
    expect(values.get("config/ai/context.d/00-gsv.md")).toContain("[Process Event]:");
  });

  it("list(prefix with trailing slash) behaves the same", () => {
    expect(store.list("config/ai/")).toEqual(store.list("config/ai"));
  });

  it("defines common process context once for all profiles", () => {
    const context = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/00-gsv.md"];
    expect(context).toContain("You are running inside GSV, a Linux-shaped cloud computer");
    expect(context).toContain("[Process Event]:");
    const targets = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/05-targets.md"];
    expect(targets).toContain("GSV tools are targetable");
    expect(targets).toContain("Browser targets are extension-provided active browsers");
    expect(targets).toContain("target-aware copy");
    expect(targets).toContain("cp source-target:/path destination-target:/path");
    expect(targets).toContain("skills show browser-shell");
    const orchestration = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/30-process-orchestration.md"];
    expect(orchestration).toContain("target: \"gsv\"");
    expect(orchestration).toContain("proc agents");
    expect(orchestration).toContain("proc spawn");
    expect(orchestration).toContain("--as <account>");
    expect(orchestration).toContain("crontab FILE");
    expect(orchestration).toContain("/var/spool/cron/<username>");
    expect(orchestration).toContain("sched list");
    expect(orchestration).not.toContain("proc profiles");
    expect(orchestration).not.toContain("~/profiles.d");
    expect(orchestration).not.toContain("SpawnProcess");
    const runtimeFacts = SYSTEM_CONFIG_DEFAULTS["config/ai/context.d/10-runtime.md"];
    expect(runtimeFacts).toContain("User: {{user.username}}");
    expect(runtimeFacts).toContain("User home: {{user.home}}");
    expect(runtimeFacts).toContain("Current program: {{program.username}}");
    expect(runtimeFacts).toContain("Program home: {{program.home}}");
    expect(runtimeFacts).toContain("Program current working directory: {{program.cwd}}");
    expect(runtimeFacts).toContain("`~` resolves to the current program home");

    // Per-agent persona/context now lives in account homes, not in config.
    for (const profile of ["init", "task", "review", "cron", "mcp", "app"]) {
      expect(SYSTEM_CONFIG_DEFAULTS[`config/ai/profile/${profile}/context.d/00-role.md`]).toBeUndefined();
    }
  });

  it("defines a global default tool approval policy where workers can run ordinary shell commands", () => {
    const policy = JSON.parse(SYSTEM_CONFIG_DEFAULTS["config/ai/tools/approval"]);

    expect(policy.default).toBe("auto");
    expect(policy.rules).not.toContainEqual({ match: "shell.exec", action: "ask" });
    expect(policy.rules).toContainEqual({
      match: "shell.exec",
      when: { anyTag: ["destructive", "privileged", "network", "mutating", "unclassified"] },
      action: "ask",
    });
    expect(policy.rules).toContainEqual({ match: "fs.delete", action: "ask" });
  });
});
