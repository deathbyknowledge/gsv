import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import {
  LEDGER_DETAIL_LIMIT,
  LEDGER_SEGMENT_ROWS,
  LEDGER_WINDOW_AGE_MS,
  LEDGER_WINDOW_ROWS,
  LedgerStore,
  type LedgerObjectStore,
  ledgerTargetOf,
  outcomeOfResponse,
  redactDetail,
  usageOfResponse,
  type LedgerAppend,
} from "./ledger";

/** An in-memory stand-in for the installation's bucket: puts, gets, heads, and a failure switch. */
class MemoryBucket {
  readonly objects = new Map<string, string>();
  failPuts = false;
  async put(key: string, value: string): Promise<null> {
    if (this.failPuts) throw new Error("storage unavailable");
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
    expect(redactDetail("shell.exec", { input: "message ana <<GSV_MESSAGE\nsecret body\nGSV_MESSAGE" })).toBe("message ana <<GSV_MESSAGE");
    expect(redactDetail("fs.read", { path: "~/Downloads/invoice.pdf", content: "never" })).toBe("~/Downloads/invoice.pdf");
    expect(redactDetail("net.fetch", { url: "https://api.example.com/v1/secret?token=abc" })).toBe("api.example.com");
    expect(redactDetail("fs.copy", { from: "a.txt", to: "b.txt" })).toBe("a.txt → b.txt");
    expect(redactDetail("ai.text.generate", { model: "gsv/default", prompt: "never" })).toBe("gsv/default");
    expect(redactDetail("conversation.send", { text: "never" })).toBe("");
  });
  it("caps the line", () => {
    expect(redactDetail("shell.exec", { input: "x".repeat(500) })).toHaveLength(LEDGER_DETAIL_LIMIT);
  });
  it("names the place", () => {
    expect(ledgerTargetOf({ target: "laptop", path: "~" })).toBe("laptop");
    expect(ledgerTargetOf({ path: "~" })).toBe("gsv");
  });
});

describe("outcomeOfResponse", () => {
  it("maps frames to the four words", () => {
    expect(outcomeOfResponse({ type: "res", id: "1", ok: true, data: {} })).toBe("ok");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 403, message: "no" } })).toBe("denied");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 499, message: "no" } })).toBe("cancelled");
    expect(outcomeOfResponse({ type: "res", id: "1", ok: false, error: { code: 504, message: "no" } })).toBe("failed");
  });
  it("reads usage when a response carries it", () => {
    expect(usageOfResponse({ type: "res", id: "1", ok: true, data: { usage: { inputTokens: 10, outputTokens: 5, costNanoUsd: 7 } } })).toEqual({ tokens: 15, costNanoUsd: 7 });
    expect(usageOfResponse({ type: "res", id: "1", ok: true, data: { text: "hi" } })).toEqual({});
  });
});

describe("LedgerStore", () => {
  it("appends open lines and completes them with outcome and duration", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const store = new LedgerStore(sql, storage, bucketOf(new MemoryBucket()));
      const seq = store.append(entry({ requestId: "r1", timestamp: 1_000 }));
      expect(seq).toBeGreaterThan(0);
      const open = await store.list({ ownerUid: 1000, limit: 10 });
      expect(open.lines[0]).toMatchObject({ seq, call: "fs.read", outcome: null, durationMs: null });
      expect(store.complete("r1", { outcome: "ok" }, 1_250)).toBe(true);
      expect(store.complete("r1", { outcome: "failed" }, 1_300)).toBe(false);
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
        store.append(entry({ requestId, timestamp: now - LEDGER_WINDOW_AGE_MS - 1_000 + i, pid: i % 2 ? "p1" : null, target: i % 3 ? "laptop" : "gsv" }));
        if (i !== 5) store.complete(requestId, { outcome: "ok" }, now - LEDGER_WINDOW_AGE_MS - 500 + i);
      }
      store.append(entry({ requestId: "fresh", timestamp: now - 1_000 }));
      expect(store.needsRotation(now)).toBe(true);

      const result = await store.rotateOnce(now);
      expect(result.rotated).toBe(true);
      if (!result.rotated) return;
      expect(result.segment).toMatchObject({ rowCount: 6, pids: ["p1"], targets: ["gsv", "laptop"] });
      expect(store.windowCount()).toBe(1);
      expect(store.segments()).toHaveLength(1);
      const body = memory.objects.get(result.segment.objectKey);
      expect(body?.split("\n").filter(Boolean)).toHaveLength(6);
      // the line still open past the window age left as cancelled
      expect(body).toContain('"outcome":"cancelled"');
      expect(store.needsRotation(now)).toBe(false);
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

  it("pages newest first across the window and the segments with a cursor", async () => {
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
        store.append(entry({ requestId: `new-${i}`, timestamp: now - 10 + i, detail: `new ${i}` }));
      }

      const page1 = await store.list({ ownerUid: 1000, limit: 4 });
      expect(page1.lines.map((line) => line.detail)).toEqual(["new 2", "new 1", "new 0", "old 4"]);
      expect(page1.nextCursor).toMatch(/^s:/);
      const page2 = await store.list({ ownerUid: 1000, limit: 4, cursor: page1.nextCursor ?? undefined });
      expect(page2.lines.map((line) => line.detail)).toEqual(["old 3", "old 2", "old 1", "old 0"]);
      expect(page2.nextCursor).toBeNull();

      const laptop = await store.list({ ownerUid: 1000, target: "laptop", limit: 10 });
      expect(laptop.lines.map((line) => line.detail)).toEqual(["old 2", "old 1", "old 0"]);
      const none = await store.list({ ownerUid: 1000, pid: "nobody", limit: 10 });
      expect(none.lines).toEqual([]);
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
