import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityStore,
  hasCapability,
  isValidCapability,
} from "./capabilities";
import {
  createMockSqlTables,
  handleMockSchemaStatement,
  mockSqlRows,
  type MockSqlRow,
} from "../test-support/mock-sql";

function createMockSql() {
  const { tables, getTable } = createMockSqlTables();

  function exec<T = MockSqlRow>(query: string, ...bindings: unknown[]) {
    const q = query.trim();

    const schemaResult = handleMockSchemaStatement<T>(q, getTable);
    if (schemaResult) return schemaResult;

    if (q.startsWith("SELECT COUNT")) {
      const table = getTable("group_capabilities");
      return mockSqlRows([{ cnt: table.length }] as T[]);
    }

    if (q.startsWith("INSERT OR IGNORE")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      const exists = table.some(
        (r) => r.gid === gid && r.capability === capability,
      );
      if (!exists) table.push({ gid, capability });
      return mockSqlRows<T>();
    }

    if (q.startsWith("INSERT INTO")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      table.push({ gid, capability });
      return mockSqlRows<T>();
    }

    if (q.startsWith("DELETE FROM")) {
      const table = getTable("group_capabilities");
      const [gid, capability] = bindings as [number, string];
      const idx = table.findIndex(
        (r) => r.gid === gid && r.capability === capability,
      );
      if (idx >= 0) table.splice(idx, 1);
      return mockSqlRows<T>();
    }

    if (q.startsWith("SELECT DISTINCT capability")) {
      const table = getTable("group_capabilities");
      const gids = bindings as number[];
      const caps = new Set<string>();
      for (const row of table) {
        if (gids.includes(row.gid as number)) caps.add(row.capability as string);
      }
      return mockSqlRows(Array.from(caps).map((c) => ({ capability: c })) as T[]);
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
        return mockSqlRows(filtered as T[]);
      }
      const sorted = [...table].sort((a, b) => {
        const gidDiff = (a.gid as number) - (b.gid as number);
        if (gidDiff !== 0) return gidDiff;
        return (a.capability as string).localeCompare(b.capability as string);
      });
      return mockSqlRows(sorted as T[]);
    }

    return mockSqlRows<T>();
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
    expect(hasCapability(["sys.mcp.*"], "sys.mcp.add")).toBe(true);
    expect(hasCapability(["sys.mcp.*"], "sys.mcp.call")).toBe(true);
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
    expect(hasCapability(caps, "adapter.send")).toBe(false);
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
    expect(isValidCapability("sys.mcp.*")).toBe(true);
  });

  it("accepts exact syscall names", () => {
    expect(isValidCapability("fs.read")).toBe(true);
    expect(isValidCapability("proc.exec")).toBe(true);
    expect(isValidCapability("adapter.send")).toBe(true);
    expect(isValidCapability("sys.mcp.add")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isValidCapability("")).toBe(false);
    expect(isValidCapability("hello world")).toBe(false);
    expect(isValidCapability("fs")).toBe(false);
    expect(isValidCapability(".read")).toBe(false);
    expect(isValidCapability("fs.")).toBe(false);
    expect(isValidCapability("fs..read")).toBe(false);
    expect(isValidCapability("fs.*.read")).toBe(false);
    expect(isValidCapability("**")).toBe(false);
    expect(isValidCapability("FS.READ")).toBe(false);
  });
});

describe("CapabilityStore", () => {
  let store: CapabilityStore;

  beforeEach(() => {
    const sql = createMockSql();
    store = new CapabilityStore(sql);
  });

  it("seed populates the table with default capabilities", () => {
    store.seed();
    const all = store.list();
    expect(all.length).toBeGreaterThan(0);

    const rootCaps = store.list(0);
    expect(rootCaps).toEqual([{ gid: 0, capability: "*" }]);

    const userCaps = store.list(100);
    expect(userCaps.map((r) => r.capability)).toEqual([
      "account.create",
      "account.list",
      "adapter.connect",
      "adapter.disconnect",
      "adapter.list",
      "adapter.status",
      "ai.image.generate",
      "ai.image.read",
      "ai.speech.create",
      "ai.text.generate",
      "ai.transcription.create",
      "app.*",
      "codemode.*",
      "fs.*",
      "net.fetch",
      "notification.*",
      "pkg.add",
      "pkg.checkout",
      "pkg.create",
      "pkg.install",
      "pkg.list",
      "pkg.public.list",
      "pkg.public.set",
      "pkg.remote.add",
      "pkg.remote.list",
      "pkg.remote.remove",
      "pkg.remove",
      "pkg.review.approve",
      "proc.*",
      "repo.apply",
      "repo.compare",
      "repo.create",
      "repo.delete",
      "repo.diff",
      "repo.import",
      "repo.list",
      "repo.log",
      "repo.read",
      "repo.refs",
      "repo.search",
      "repo.visibility.set",
      "sched.*",
      "shell.*",
      "signal.*",
      "sys.bootstrap",
      "sys.config.get",
      "sys.config.set",
      "sys.device.delete",
      "sys.device.get",
      "sys.device.list",
      "sys.device.update",
      "sys.link",
      "sys.link.consume",
      "sys.link.list",
      "sys.mcp.add",
      "sys.mcp.call",
      "sys.mcp.list",
      "sys.mcp.refresh",
      "sys.mcp.remove",
      "sys.oauth.device.poll",
      "sys.oauth.device.start",
      "sys.oauth.forget",
      "sys.oauth.list",
      "sys.oauth.start",
      "sys.token.create",
      "sys.token.list",
      "sys.token.revoke",
      "sys.unlink",
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
    const result = store.grant(100, "adapter.send");
    expect(result.ok).toBe(true);

    const caps = store.list(100);
    expect(caps.map((r) => r.capability)).toContain("adapter.send");
  });

  it("grant is idempotent", () => {
    store.seed();
    store.grant(100, "adapter.send");
    store.grant(100, "adapter.send");

    const caps = store.list(100);
    const adapterCount = caps.filter((r) => r.capability === "adapter.send").length;
    expect(adapterCount).toBe(1);
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
    expect(serviceCaps).toEqual([{ gid: 102, capability: "adapter.*" }]);
  });

  it("end-to-end: grant + check capability", () => {
    store.seed();

    store.grant(100, "adapter.send");
    const caps = store.resolve([100]);
    expect(hasCapability(caps, "adapter.send")).toBe(true);
    expect(hasCapability(caps, "adapter.inbound")).toBe(false);
  });
});
