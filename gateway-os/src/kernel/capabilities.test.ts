import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityStore,
  hasCapability,
  isValidCapability,
} from "./capabilities";

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

    if (q.startsWith("SELECT COUNT")) {
      const table = getTable("group_capabilities");
      return { toArray: () => [{ cnt: table.length }] as T[] };
    }

    if (q.startsWith("INSERT OR IGNORE")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      const exists = table.some(
        (r) => r.gid === gid && r.capability === capability,
      );
      if (!exists) table.push({ gid, capability });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("INSERT INTO")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      table.push({ gid, capability });
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("DELETE FROM")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      const idx = table.findIndex(
        (r) => r.gid === gid && r.capability === capability,
      );
      if (idx >= 0) table.splice(idx, 1);
      return { toArray: () => [] as T[] };
    }

    if (q.startsWith("SELECT DISTINCT capability")) {
      const table = getTable("group_capabilities");
      const gids = bindings as number[];
      const caps = new Set<string>();
      for (const row of table) {
        if (gids.includes(row.gid as number)) caps.add(row.capability as string);
      }
      return {
        toArray: () => Array.from(caps).map((c) => ({ capability: c })) as T[],
      };
    }

    if (q.startsWith("SELECT gid, capability")) {
      const table = getTable("group_capabilities");
      if (bindings.length > 0) {
        const gid = bindings[0] as number;
        const filtered = table
          .filter((r) => r.gid === gid)
          .sort((a, b) =>
            (a.capability as string).localeCompare(b.capability as string),
          );
        return { toArray: () => filtered as T[] };
      }
      const sorted = [...table].sort((a, b) => {
        const gidDiff = (a.gid as number) - (b.gid as number);
        if (gidDiff !== 0) return gidDiff;
        return (a.capability as string).localeCompare(b.capability as string);
      });
      return { toArray: () => sorted as T[] };
    }

    return { toArray: () => [] as T[] };
  }

  return { exec, _tables: tables };
}

describe("hasCapability", () => {
  it("* matches any syscall", () => {
    expect(hasCapability(["*"], "fs.read")).toBe(true);
    expect(hasCapability(["*"], "proc.exec")).toBe(true);
    expect(hasCapability(["*"], "anything.here")).toBe(true);
  });

  it("domain.* matches all syscalls in that domain", () => {
    expect(hasCapability(["fs.*"], "fs.read")).toBe(true);
    expect(hasCapability(["fs.*"], "fs.write")).toBe(true);
    expect(hasCapability(["fs.*"], "fs.delete")).toBe(true);
  });

  it("domain.* does not match other domains", () => {
    expect(hasCapability(["fs.*"], "proc.exec")).toBe(false);
    expect(hasCapability(["fs.*"], "session.send")).toBe(false);
  });

  it("exact match works", () => {
    expect(hasCapability(["proc.exec"], "proc.exec")).toBe(true);
    expect(hasCapability(["proc.exec"], "proc.list")).toBe(false);
  });

  it("checks all capabilities in the set", () => {
    const caps = ["fs.*", "proc.exec", "session.send"];
    expect(hasCapability(caps, "fs.read")).toBe(true);
    expect(hasCapability(caps, "proc.exec")).toBe(true);
    expect(hasCapability(caps, "session.send")).toBe(true);
    expect(hasCapability(caps, "proc.list")).toBe(false);
    expect(hasCapability(caps, "ipc.send")).toBe(false);
  });

  it("empty capabilities denies everything", () => {
    expect(hasCapability([], "fs.read")).toBe(false);
  });
});

describe("isValidCapability", () => {
  it("accepts * wildcard", () => {
    expect(isValidCapability("*")).toBe(true);
  });

  it("accepts domain wildcards", () => {
    expect(isValidCapability("fs.*")).toBe(true);
    expect(isValidCapability("proc.*")).toBe(true);
    expect(isValidCapability("session.*")).toBe(true);
  });

  it("accepts exact syscall names", () => {
    expect(isValidCapability("fs.read")).toBe(true);
    expect(isValidCapability("proc.exec")).toBe(true);
    expect(isValidCapability("ipc.send")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidCapability("")).toBe(false);
    expect(isValidCapability("hello world")).toBe(false);
    expect(isValidCapability("fs")).toBe(false);
    expect(isValidCapability(".read")).toBe(false);
    expect(isValidCapability("fs.")).toBe(false);
    expect(isValidCapability("fs.read.extra")).toBe(false);
    expect(isValidCapability("**")).toBe(false);
    expect(isValidCapability("FS.READ")).toBe(false);
  });
});

describe("CapabilityStore", () => {
  let store: CapabilityStore;

  beforeEach(() => {
    const sql = createMockSql();
    store = new CapabilityStore(sql);
    store.init();
  });

  it("seed populates the table with default capabilities", () => {
    store.seed();
    const all = store.list();
    expect(all.length).toBeGreaterThan(0);

    const rootCaps = store.list(0);
    expect(rootCaps).toEqual([{ gid: 0, capability: "*" }]);

    const userCaps = store.list(100);
    expect(userCaps.map((r) => r.capability)).toEqual([
      "fs.*",
      "proc.*",
      "sched.*",
      "shell.*",
    ]);
  });

  it("seed is idempotent", () => {
    store.seed();
    const countBefore = store.list().length;
    store.seed();
    const countAfter = store.list().length;
    expect(countAfter).toBe(countBefore);
  });

  it("resolve returns union of capabilities", () => {
    store.seed();

    const caps = store.resolve([100, 101]);
    expect(caps).toContain("fs.*");
    expect(caps).toContain("shell.*");
    expect(caps).toContain("proc.*");
  });

  it("resolve with empty array returns empty", () => {
    store.seed();
    expect(store.resolve([])).toEqual([]);
  });

  it("resolve with unknown gid returns empty", () => {
    store.seed();
    expect(store.resolve([9999])).toEqual([]);
  });

  it("grant adds a new capability", () => {
    store.seed();
    const result = store.grant(100, "ipc.send");
    expect(result.ok).toBe(true);

    const caps = store.list(100);
    expect(caps.map((r) => r.capability)).toContain("ipc.send");
  });

  it("grant is idempotent", () => {
    store.seed();
    store.grant(100, "ipc.send");
    store.grant(100, "ipc.send");

    const caps = store.list(100);
    const ipcCount = caps.filter((r) => r.capability === "ipc.send").length;
    expect(ipcCount).toBe(1);
  });

  it("grant rejects invalid format", () => {
    const result = store.grant(100, "not valid!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid capability format");
  });

  it("revoke removes a capability", () => {
    store.seed();
    store.revoke(100, "fs.*");

    const caps = store.list(100);
    expect(caps.map((r) => r.capability)).not.toContain("fs.*");
  });

  it("revoke on nonexistent entry is a no-op", () => {
    store.seed();
    const result = store.revoke(100, "nonexistent.cap");
    expect(result.ok).toBe(true);
  });

  it("list without gid returns all entries", () => {
    store.seed();
    const all = store.list();
    const gids = new Set(all.map((r) => r.gid));
    expect(gids.has(0)).toBe(true);
    expect(gids.has(100)).toBe(true);
    expect(gids.has(101)).toBe(true);
    expect(gids.has(102)).toBe(true);
  });

  it("list with gid returns only that group", () => {
    store.seed();
    const serviceCaps = store.list(102);
    expect(serviceCaps).toEqual([{ gid: 102, capability: "ipc.*" }]);
  });

  it("end-to-end: grant + check capability", () => {
    store.seed();

    store.grant(100, "ipc.send");
    const caps = store.resolve([100]);
    expect(hasCapability(caps, "ipc.send")).toBe(true);
    expect(hasCapability(caps, "ipc.status")).toBe(false);
  });
});
