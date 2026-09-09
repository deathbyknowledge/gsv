import { describe, expect, it, vi } from "vitest";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { deferred } from "../../gsv-console/messengers/messengerTestHarness";
import { loadLedgerBatch, loadTimeline } from "./ledgerAnalyticsService";

const window = { since: 100, until: 1_000 };

describe("ledger analysis reads", () => {
  it("follows empty archive pages with a fixed time window and returns a bounded continuation", async () => {
    const request = vi.fn<GSVClient["request"]>();
    for (let page = 1; page <= 5; page += 1) {
      request.mockResolvedValueOnce({ data: { lines: [], nextCursor: `page:${page}` } });
    }
    const signal = new AbortController().signal;
    await expect(loadLedgerBatch({ request }, window, null, signal)).resolves.toEqual({ lines: [], nextCursor: "page:5" });
    expect(request).toHaveBeenCalledTimes(5);
    for (let page = 0; page < 5; page += 1) {
      expect(request).toHaveBeenNthCalledWith(page + 1, "sys.ledger.list", {
        ...window, limit: 200, ...(page ? { cursor: `page:${page}` } : {}),
      }, { signal });
    }
  });

  it("stops a repeated cursor instead of rereading the same page", async () => {
    const request = vi.fn<GSVClient["request"]>().mockResolvedValue({ data: { lines: [], nextCursor: "stuck" } });
    await expect(loadLedgerBatch({ request }, window, "stuck", new AbortController().signal)).rejects.toThrow("repeated page cursor");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not fetch another archive page after cancellation", async () => {
    const controller = new AbortController();
    const request = vi.fn<GSVClient["request"]>().mockImplementationOnce(async () => {
      controller.abort();
      return { data: { lines: [], nextCursor: "next" } };
    });
    await expect(loadLedgerBatch({ request }, window, null, controller.signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds simultaneous process reads and keeps successful traces when another process is unavailable", async () => {
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    const request = vi.fn<GSVClient["request"]>();
    for (let index = 0; index < 7; index += 1) {
      request.mockImplementationOnce(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await release.promise;
        active -= 1;
        if (index === 2) throw new Error("Process no longer exists");
        return { data: { ok: true, pid: `proc:${index}`, spans: [], truncated: false } };
      });
    }
    const operation = loadTimeline({ request }, Array.from({ length: 7 }, (_, index) => `proc:${index}`), new AbortController().signal);
    expect(request).toHaveBeenCalledTimes(4);
    release.resolve();
    const reads = await operation;
    expect(peak).toBe(4);
    expect(reads.filter((read) => "value" in read)).toHaveLength(6);
    expect(reads).toContainEqual({ pid: "proc:2", error: "Process no longer exists" });
  });
});
