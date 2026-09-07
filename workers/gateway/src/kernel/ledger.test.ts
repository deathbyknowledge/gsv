import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { Kernel } from "./do";
import {
  LEDGER_DETAIL_LIMIT,
  LEDGER_ID_LIMIT,
  LEDGER_SEGMENTS_PER_READ,
  LEDGER_SEGMENT_ROWS,
  LEDGER_WINDOW_AGE_MS,
  LEDGER_WINDOW_ROWS,
  LedgerStore,
  type LedgerObjectStore,
  ledgerTargetOf,
  outcomeOfResponse,
  redactDetail,
  redactShellInput,
  usageOfResponse,
  type LedgerAppend,
} from "./ledger";

/** An in-memory stand-in for the installation's bucket: puts, gets, heads, a failure switch, and a hook that runs mid-put. */
class MemoryBucket {
  readonly objects = new Map<string, string>();
  failPuts = false;
  duringPut: (() => void) | null = null;
  async put(key: string, value: string): Promise<null> {
    if (this.failPuts) throw new Error("storage unavailable");
    await Promise.resolve();
    this.duringPut?.();
    this.objects.set(key, value);
    return null;
  }
  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async head(key: string): Promise<{ key: string } | null> {
    return this.objects.has(key) ? { key } : null;
  }
}

function bucketOf(memory: MemoryBucket): LedgerObjectStore {
  return memory;
}

function entry(overrides: Partial<LedgerAppend> = {}): LedgerAppend {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    timestamp: 1_000,
    principalKind: "human",
    uid: 1000,
    ownerUid: 1000,
    pid: null,
    runId: null,
    target: "gsv",
    call: "fs.read",
    detail: "~/notes.txt",
    ...overrides,
  };
}

describe("redactDetail", () => {
  it("keeps the argument that matters and nothing else", () => {
    expect(redactDetail("fs.read", { path: "~/Downloads/invoice.pdf", content: "never" })).toBe("~/Downloads/invoice.pdf");
    expect(redactDetail("net.fetch", { url: "https://api.example.com/v1/secret?token=abc" })).toBe("api.example.com");
    expect(redactDetail("fs.copy", { from: "a.txt", to: "b.txt" })).toBe("a.txt → b.txt");
    expect(redactDetail("ai.text.generate", { model: "gsv/default", prompt: "never" })).toBe("gsv/default");
    expect(redactDetail("conversation.send", { text: "never" })).toBe("");
  });
  it("keeps only a shell command's shape", () => {
    expect(redactShellInput("message ana <<GSV_MESSAGE\nsecret body\nGSV_MESSAGE")).toBe("message ana");
    expect(redactShellInput('message send --message "the secret text" ana')).toBe("message send");
    expect(redactShellInput('curl -H "Authorization: Bearer abc" https://x.test/a?b=c')).toBe("curl");
    expect(redactShellInput("curl https://user:pw@x.test/path?token=1#frag")).toBe("curl https://x.test/path");
    expect(redactShellInput("ls -la ~/Downloads")).toBe("ls");
    expect(redactShellInput("cp a.txt b.txt")).toBe("cp a.txt");
    expect(redactShellInput("git --data=x commit")).toBe("git");
    expect(redactShellInput("")).toBe("");
  });
  it("caps the line and marks the cut", () => {
    const capped = redactDetail("fs.read", { path: "x".repeat(500) });
    expect(capped).toHaveLength(LEDGER_DETAIL_LIMIT);
    expect(capped.endsWith("…")).toBe(true);
  });
  it("names the place and caps it", () => {
    expect(ledgerTargetOf({ target: "laptop", path: "~" })).toBe("laptop");
    expect(ledgerTargetOf({ path: "~" })).toBe("gsv");
    expect(ledgerTargetOf({ target: "t".repeat(1_000) })).toHaveLength(LEDGER_ID_LIMIT);
  });
});

describe("outcomeOfResponse", () => {
  it("maps frames to the four words", () => {
    expect(outcomeOfResponse({ type: "res", id: "1", ok: true, data: {} })).toBe("ok");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 403, message: "no" } })).toBe("denied");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 499, message: "no" } })).toBe("cancelled");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 504, message: "no" } })).toBe("failed");
  });
  it("reads usage from an ai.text.generate result", () => {
    const result = {
      provider: "gsv",
      model: "gsv/default",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        api: "chat",
        provider: "gsv",
        model: "gsv/default",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } },
      },
    };
    expect(usageOfResponse({ type: "res", id: "1", ok: true, data: result })).toEqual({ tokens: 15, costNanoUsd: 3_000_000 });
    expect(usageOfResponse({ type: "res", id: "1", ok: true, data: { text: "hi" } })).toEqual({});
  });
});

describe("LedgerStore", () => {
  it("appends open lines, caps every client field, and completes with outcome and duration", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const store = new LedgerStore(sql, storage, bucketOf(new MemoryBucket()));
      const seq = store.append(entry({ requestId: "r".repeat(1_000), timestamp: 1_000, target: "t".repeat(1_000), detail: "d".repeat(1_000) }));
      expect(seq).toBeGreaterThan(0);
      const open = await store.list({ ownerUid: 1000, limit: 10 });
      expect(open.lines[0]).toMatchObject({ seq, call: "fs.read", outcome: null, durationMs: null });
      expect(open.lines[0].target).toHaveLength(LEDGER_ID_LIMIT);
      expect(open.lines[0].detail).toHaveLength(LEDGER_DETAIL_LIMIT);
      expect(store.complete("r".repeat(1_000), { outcome: "ok" }, 1_250)).toBe(true);
      expect(store.complete("r".repeat(1_000), { outcome: "failed" }, 1_300)).toBe(false);
      const done = await store.list({ ownerUid: 1000, limit: 10 });
      expect(done.lines[0]).toMatchObject({ outcome: "ok", durationMs: 250 });
    });
  });

  it("keeps a caller to its owner's lines and lets root see all", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const store = new LedgerStore(sql, storage, bucketOf(new MemoryBucket()));
      store.append(entry({ ownerUid: 1000, call: "fs.read" }));
      store.append(entry({ ownerUid: 1001, call: "shell.exec", detail: "ls" }));
      expect((await store.list({ ownerUid: 1000, limit: 10 })).lines.map((line) => line.call)).toEqual(["fs.read"]);
      expect((await store.list({ ownerUid: null, limit: 10 })).lines).toHaveLength(2);
      expect((await store.list({ ownerUid: null, callPrefix: "shell.", limit: 10 })).lines.map((line) => line.detail)).toEqual(["ls"]);
    });
  });

  it("rotates closed lines into a segment and prunes the window in one step", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 10_000_000;
      for (let i = 0; i < 6; i += 1) {
        const requestId = `old-${i}`;
        store.append(entry({ requestId, timestamp: now - LEDGER_WINDOW_AGE_MS - 1_000 + i, pid: i % 2 ? "p1" : null, target: i % 3 ? "laptop" : "gsv", ownerUid: i < 4 ? 1000 : 1001 }));
        if (i !== 5) store.complete(requestId, { outcome: "ok" }, now - LEDGER_WINDOW_AGE_MS - 500 + i);
      }
      store.append(entry({ requestId: "fresh", timestamp: now - 1_000 }));
      expect(store.needsRotation(now)).toBe(true);

      const result = await store.rotateOnce(now);
      expect(result.rotated).toBe(true);
      if (!result.rotated) return;
      expect(result.segment).toMatchObject({ rowCount: 6, uids: [1000, 1001], pids: ["p1"], targets: ["gsv", "laptop"] });
      expect(store.windowCount()).toBe(1);
      expect(store.segments()).toHaveLength(1);
      const body = memory.objects.get(result.segment.objectKey);
      expect(body?.split("\n").filter(Boolean)).toHaveLength(6);
      // the line still open past the window age left as cancelled
      expect(body).toContain('"outcome":"cancelled"');
      expect(store.needsRotation(now)).toBe(false);
    });
  });

  it("never deletes a line that completed while the object was being written", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 10_000_000;
      // an old open line, and closed ones around it
      store.append(entry({ requestId: "closed-1", timestamp: now - LEDGER_WINDOW_AGE_MS - 100 }));
      store.complete("closed-1", { outcome: "ok" }, now - LEDGER_WINDOW_AGE_MS - 90);
      store.append(entry({ requestId: "open", timestamp: now - 1_000 }));
      store.append(entry({ requestId: "closed-2", timestamp: now - 900 }));
      store.complete("closed-2", { outcome: "ok" }, now - 800);
      // the open line completes during the put, after the rows were captured
      memory.duringPut = () => {
        store.complete("open", { outcome: "ok" }, now);
      };
      const first = await store.rotateOnce(now);
      expect(first.rotated && first.segment.rowCount).toBe(2);
      expect(store.windowCount()).toBe(1);
      const everything = await store.list({ ownerUid: 1000, limit: 10 });
      expect(everything.lines).toHaveLength(3);
      expect(everything.lines.every((line) => line.outcome === "ok")).toBe(true);
      memory.duringPut = null;
      // it rotates in the next segment, with a lower seq than the previous segment's last: ranges overlap by design
      sql.exec("UPDATE ledger_window SET ts = ?", now - LEDGER_WINDOW_AGE_MS - 1);
      const second = await store.rotateOnce(now);
      expect(second.rotated && second.segment.rowCount).toBe(1);
      expect(store.windowCount()).toBe(0);
      const all = await store.list({ ownerUid: 1000, limit: 10 });
      expect(all.lines).toHaveLength(3);
    });
  });

  it("leaves the window untouched when the object write fails", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      memory.failPuts = true;
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 10_000_000;
      for (let i = 0; i < 3; i += 1) {
        store.append(entry({ requestId: `r${i}`, timestamp: now - LEDGER_WINDOW_AGE_MS - 10 }));
        store.complete(`r${i}`, { outcome: "ok" }, now);
      }
      await expect(store.rotateOnce(now)).rejects.toThrow("storage unavailable");
      expect(store.windowCount()).toBe(3);
      expect(store.segments()).toHaveLength(0);
      memory.failPuts = false;
      expect((await store.rotateOnce(now)).rotated).toBe(true);
      expect(store.windowCount()).toBe(0);
    });
  });

  it("rotates by row bound in segment-sized pieces", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const store = new LedgerStore(sql, storage, bucketOf(new MemoryBucket()));
      const now = 5_000_000;
      for (let i = 0; i < LEDGER_WINDOW_ROWS + 10; i += 1) {
        const requestId = `r${i}`;
        store.append(entry({ requestId, timestamp: now - 1_000 + i }));
        store.complete(requestId, { outcome: "ok" }, now);
      }
      const first = await store.rotateOnce(now);
      expect(first.rotated && first.segment.rowCount).toBe(LEDGER_SEGMENT_ROWS);
      expect(store.windowCount()).toBe(LEDGER_WINDOW_ROWS + 10 - LEDGER_SEGMENT_ROWS);
      expect((await store.rotateOnce(now)).rotated).toBe(false);
    });
  });

  it("pages newest first across the window and the segments without repeating across a rotation", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 20_000_000;
      for (let i = 0; i < 5; i += 1) {
        const requestId = `old-${i}`;
        store.append(entry({ requestId, timestamp: now - LEDGER_WINDOW_AGE_MS - 100 + i, detail: `old ${i}`, target: i < 3 ? "laptop" : "gsv" }));
        store.complete(requestId, { outcome: "ok" }, now);
      }
      expect((await store.rotateOnce(now)).rotated).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        const requestId = `new-${i}`;
        store.append(entry({ requestId, timestamp: now - 10 + i, detail: `new ${i}` }));
        store.complete(requestId, { outcome: "ok" }, now);
      }

      const page1 = await store.list({ ownerUid: 1000, limit: 2 });
      expect(page1.lines.map((line) => line.detail)).toEqual(["new 2", "new 1"]);
      expect(page1.nextCursor).toMatch(/^\d+:\d+:w$/);
      // a rotation lands between pages: the window lines move into a newer segment
      sql.exec("UPDATE ledger_window SET ts = ?", now - LEDGER_WINDOW_AGE_MS - 1);
      expect((await store.rotateOnce(now)).rotated).toBe(true);
      const page2 = await store.list({ ownerUid: 1000, limit: 2, cursor: page1.nextCursor ?? undefined });
      expect(page2.lines.map((line) => line.detail)).toEqual(["new 0", "old 4"]);
      const page3 = await store.list({ ownerUid: 1000, limit: 10, cursor: page2.nextCursor ?? undefined });
      expect(page3.lines.map((line) => line.detail)).toEqual(["old 3", "old 2", "old 1", "old 0"]);
      expect(page3.nextCursor).toBeNull();

      const laptop = await store.list({ ownerUid: 1000, target: "laptop", limit: 10 });
      expect(laptop.lines.map((line) => line.detail)).toEqual(["old 2", "old 1", "old 0"]);
      const none = await store.list({ ownerUid: 1000, pid: "nobody", limit: 10 });
      expect(none.lines).toEqual([]);
      expect((await store.list({ ownerUid: 4242, limit: 10 })).lines).toEqual([]);
    });
  });

  it("touches at most a few segments per read and hands back a cursor to continue", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 40_000_000;
      for (let segment = 0; segment < LEDGER_SEGMENTS_PER_READ + 2; segment += 1) {
        const requestId = `s${segment}`;
        store.append(entry({ requestId, timestamp: now - LEDGER_WINDOW_AGE_MS - 10, detail: `seg ${segment}`, target: "elsewhere" }));
        store.complete(requestId, { outcome: "ok" }, now);
        expect((await store.rotateOnce(now)).rotated).toBe(true);
      }
      expect(store.segments()).toHaveLength(LEDGER_SEGMENTS_PER_READ + 2);
      const page = await store.list({ ownerUid: 1000, target: "nowhere", limit: 10 });
      expect(page.lines).toEqual([]);
      expect(page.nextCursor).toBeNull();
      const walk = await store.list({ ownerUid: 1000, target: "elsewhere", limit: 10 });
      expect(walk.lines).toHaveLength(LEDGER_SEGMENTS_PER_READ);
      expect(walk.nextCursor).toMatch(/^\d+:\d+:s:\d+:0$/);
      const rest = await store.list({ ownerUid: 1000, target: "elsewhere", limit: 10, cursor: walk.nextCursor ?? undefined });
      expect(rest.lines).toHaveLength(2);
      expect(rest.nextCursor).toBeNull();
    });
  });

  it("drops index entries whose object is gone", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const memory = new MemoryBucket();
      const store = new LedgerStore(sql, storage, bucketOf(memory));
      const now = 30_000_000;
      store.append(entry({ requestId: "r", timestamp: now - LEDGER_WINDOW_AGE_MS - 1 }));
      store.complete("r", { outcome: "ok" }, now);
      const result = await store.rotateOnce(now);
      if (!result.rotated) throw new Error("expected a segment");
      memory.objects.delete(result.segment.objectKey);
      expect(await store.pruneMissingSegments()).toBe(1);
      expect(store.segments()).toEqual([]);
    });
  });
});

describe("rotation scheduling", () => {
  function pendingRotations(sql: SqlStorage): { id: string; time: number }[] {
    return [...sql.exec<{ id: string; time: number }>("SELECT id, time FROM cf_agents_schedules WHERE callback = 'onLedgerRotate' ORDER BY time")];
  }

  it("keeps exactly one pending task and moves it nearer, never adds to it", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (kernel: Kernel, state) => {
      await kernel.ensureLedgerRotation(24 * 60 * 60 * 1000);
      await kernel.ensureLedgerRotation(24 * 60 * 60 * 1000);
      expect(pendingRotations(state.storage.sql)).toHaveLength(1);
      const daily = pendingRotations(state.storage.sql)[0];
      await kernel.ensureLedgerRotation(5_000);
      const soon = pendingRotations(state.storage.sql);
      expect(soon).toHaveLength(1);
      expect(soon[0].time).toBeLessThan(daily.time);
      await kernel.ensureLedgerRotation(24 * 60 * 60 * 1000);
      expect(pendingRotations(state.storage.sql)).toHaveLength(1);
      expect(pendingRotations(state.storage.sql)[0].time).toBe(soon[0].time);
    });
  });

  it("re-arms exactly once when it runs", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (kernel: Kernel, state) => {
      await kernel.onLedgerRotate("test");
      expect(pendingRotations(state.storage.sql)).toHaveLength(1);
      await kernel.onLedgerRotate("test");
      expect(pendingRotations(state.storage.sql)).toHaveLength(1);
    });
  });
});
