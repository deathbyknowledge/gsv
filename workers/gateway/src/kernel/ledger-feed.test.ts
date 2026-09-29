import { afterEach, describe, expect, it, vi } from "vitest";
import type { SysLedgerLine } from "@humansandmachines/gsv/protocol";
import { LEDGER_ARGS_LIMIT } from "./ledger";
import { LedgerFeed, LEDGER_FEED_BYTES, LEDGER_FEED_DELAY_MS, LEDGER_FEED_ROWS } from "./ledger-feed";

const line = (seq: number, outcome: SysLedgerLine["outcome"] = null): SysLedgerLine => ({
  seq, timestamp: 1000, principalKind: "human", uid: 1000, pid: null, runId: null,
  target: "gsv", call: "fs.read", args: '{"path":"~"}', outcome, durationMs: outcome === null ? null : 10,
});

afterEach(() => { vi.useRealTimers(); });

describe("LedgerFeed", () => {
  it("coalesces completion into the open row, scopes batches by owner and stops its timer when quiet", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const feed = new LedgerFeed(publish);
    feed.changed(1000, line(1));
    feed.changed(1000, line(2));
    feed.changed(1000, line(1, "ok"));
    feed.changed(1001, line(3, "failed"));
    vi.advanceTimersByTime(LEDGER_FEED_DELAY_MS - 1);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish.mock.calls).toEqual([
      [1000, { lines: [line(2), line(1, "ok")] }],
      [1001, { lines: [line(3, "failed")] }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes a full batch without losing a burst or a later completion", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const feed = new LedgerFeed(publish);
    for (let seq = 1; seq <= LEDGER_FEED_ROWS + 1; seq++) feed.changed(1000, line(seq));
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][1].lines).toHaveLength(LEDGER_FEED_ROWS);
    feed.changed(1000, line(1, "cancelled"));
    vi.advanceTimersByTime(LEDGER_FEED_DELAY_MS);
    expect(publish.mock.calls[1][1]).toEqual({ lines: [line(LEDGER_FEED_ROWS + 1), line(1, "cancelled")] });
  });

  it("bounds encoded bytes, including JSON escaping and multibyte arguments", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const feed = new LedgerFeed(publish);
    for (let seq = 1; seq <= 8; seq++) {
      feed.changed(1000, { ...line(seq), args: (seq % 2 ? "\u0000" : "雪").repeat(LEDGER_ARGS_LIMIT) });
    }
    vi.advanceTimersByTime(LEDGER_FEED_DELAY_MS);
    const batches = publish.mock.calls.map(([, payload]) => payload);
    expect(batches.flatMap((batch) => batch.lines)).toHaveLength(8);
    for (const payload of batches) {
      const frame = JSON.stringify({ type: "sig", signal: "ledger.changed", payload });
      expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(LEDGER_FEED_BYTES);
    }
  });
});
