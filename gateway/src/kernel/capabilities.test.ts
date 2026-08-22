import { describe, it, expect } from "vitest";
import {
  CapabilityStore,
  hasCapability,
  isValidCapability,
} from "./capabilities";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";

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
  const storeTest = it.extend<{ store: CapabilityStore }>({
    store: async ({}, use) => {
      await runWithRealKernelSql((sql) => {
        sql.exec("DELETE FROM group_capabilities");
        return use(new CapabilityStore(sql));
      });
    },
  });

  storeTest(
    "seed populates the table with default capabilities",
    ({ store }) => {
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
        "adapter.pair.*",
        "adapter.route",
        "adapter.send",
        "adapter.status",
        "ai.image.generate",
        "ai.image.read",
        "ai.speech.create",
        "ai.text.generate",
        "ai.transcription.create",
        "codemode.*",
        "conversation.*",
        "fs.*",
        "mail.send",
        "mail.status",
        "net.fetch",
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
    },
  );

  storeTest("seed is idempotent", ({ store }) => {
    store.seed();
    const countBefore = store.list().length;
    store.seed();
    const countAfter = store.list().length;
    expect(countAfter).toBe(countBefore);
  });

  storeTest("resolve returns union of capabilities", ({ store }) => {
    store.seed();

    const caps = store.resolve([100, 101]);
    expect(caps).toContain("fs.*");
    expect(caps).toContain("shell.*");
    expect(caps).toContain("proc.*");
  });

  storeTest("resolve with empty array returns empty", ({ store }) => {
    store.seed();
    expect(store.resolve([])).toEqual([]);
  });

  storeTest("resolve with unknown gid returns empty", ({ store }) => {
    store.seed();
    expect(store.resolve([9999])).toEqual([]);
  });

  storeTest("grant adds a new capability", ({ store }) => {
    store.seed();
    const result = store.grant(100, "adapter.send");
    expect(result.ok).toBe(true);

    const caps = store.list(100);
    expect(caps.map((r) => r.capability)).toContain("adapter.send");
  });

  storeTest("grant is idempotent", ({ store }) => {
    store.seed();
    store.grant(100, "adapter.send");
    store.grant(100, "adapter.send");

    const caps = store.list(100);
    const adapterCount = caps.filter(
      (r) => r.capability === "adapter.send",
    ).length;
    expect(adapterCount).toBe(1);
  });

  storeTest("grant rejects invalid format", ({ store }) => {
    const result = store.grant(100, "not valid!");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid capability format");
  });

  storeTest("revoke removes a capability", ({ store }) => {
    store.seed();
    store.revoke(100, "fs.*");

    const caps = store.list(100);
    expect(caps.map((r) => r.capability)).not.toContain("fs.*");
  });

  storeTest("revoke on nonexistent entry is a no-op", ({ store }) => {
    store.seed();
    const result = store.revoke(100, "nonexistent.cap");
    expect(result.ok).toBe(true);
  });

  storeTest("list without gid returns all entries", ({ store }) => {
    store.seed();
    const all = store.list();
    const gids = new Set(all.map((r) => r.gid));
    expect(gids.has(0)).toBe(true);
    expect(gids.has(100)).toBe(true);
    expect(gids.has(101)).toBe(true);
    expect(gids.has(102)).toBe(true);
  });

  storeTest("list with gid returns only that group", ({ store }) => {
    store.seed();
    const serviceCaps = store.list(102);
    expect(serviceCaps).toEqual([{ gid: 102, capability: "adapter.*" }]);
  });

  storeTest("end-to-end: grant + check capability", ({ store }) => {
    store.seed();

    store.grant(100, "adapter.send");
    const caps = store.resolve([100]);
    expect(hasCapability(caps, "adapter.send")).toBe(true);
    expect(hasCapability(caps, "adapter.inbound")).toBe(false);
  });
});
