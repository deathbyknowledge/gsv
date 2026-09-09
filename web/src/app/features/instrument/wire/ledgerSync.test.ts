import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../gsv-console/messengers/messengerTestHarness";
import { ledgerFromSysLines, type SysLedgerListResult } from "../fleet/fleetModel";
import { createLedgerSync } from "./ledgerSync";
import { INSTRUMENT_LEDGER_KEY, INSTRUMENT_LEDGER_PAGE } from "./queryKeys";
import type { LedgerPages } from "./wireModel";

const KEY = [...INSTRUMENT_LEDGER_KEY, "sys"];
function page(sequences: number[], nextCursor: string | null = null): SysLedgerListResult {
  return { lines: sequences.map((seq) => ({
    seq, timestamp: seq, principalKind: "human", uid: 1000, pid: null, runId: null,
    target: "gsv", call: "account.list", args: "{}", outcome: "ok", durationMs: 1,
  })), nextCursor };
}
function pages(sequences: number[]): LedgerPages {
  return { pages: [{ lines: ledgerFromSysLines(page(sequences).lines), nextCursor: "older" }], pageParams: [null] };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function setup(initial: LedgerPages | null = pages([10, 9]), load = vi.fn(async () => pages([10, 9]))) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cleanup.push(() => cache.clear());
  if (initial) cache.setQueryData(KEY, initial);
  const request = vi.fn<GSVClient["request"]>();
  const sync = createLedgerSync({ request }, cache);
  cleanup.push(sync.stop);
  const observer = new QueryObserver(cache, { queryKey: KEY, queryFn: load });
  let unsubscribe = observer.subscribe(() => undefined);
  const close = () => { unsubscribe(); unsubscribe = () => undefined; };
  cleanup.push(close);
  return { cache, request, sync, observer, close, load };
}

describe("live ledger read ownership", () => {
  it("does not reread notifications already covered by the cached page", async () => {
    const { sync, request } = setup();
    sync.appended(8); sync.appended(10); sync.appended(9);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for an initial page fetch and avoids a duplicate read when it covers the notification", async () => {
    const initial = deferred<LedgerPages>();
    const { sync, request, cache } = setup(null, vi.fn(() => initial.promise));
    sync.appended(11);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    initial.resolve(pages([12, 11, 10]));
    await vi.waitFor(() => expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines[0].id).toBe("sys:12"));
    expect(request).not.toHaveBeenCalled();
  });

  it("catches up after the initial fetch if its snapshot predates the notification", async () => {
    const initial = deferred<LedgerPages>();
    const { sync, request, cache } = setup(null, vi.fn(() => initial.promise));
    request.mockResolvedValueOnce({ data: page([12, 11, 10]) });
    sync.appended(11);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    initial.resolve(pages([10]));
    await vi.waitFor(() => expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines[0].id).toBe("sys:12"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping notifications into one read, including signals covered while it was in flight", async () => {
    const { sync, request, cache } = setup();
    const reply = deferred<{ data: SysLedgerListResult }>();
    request.mockReturnValueOnce(reply.promise);
    sync.appended(11);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    sync.appended(12); sync.appended(13);
    reply.resolve({ data: page([14, 13, 12, 11, 10]) });
    await vi.waitFor(() => expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines[0].id).toBe("sys:14"));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("walks a burst by cursor to the cached head and keeps the older-page continuation", async () => {
    const { sync, request, cache } = setup();
    request.mockResolvedValueOnce({ data: page(Array.from({ length: 60 }, (_, i) => 81 - i), "gap") });
    request.mockResolvedValueOnce({ data: page(Array.from({ length: 12 }, (_, i) => 21 - i), "old") });
    sync.appended(80);
    await vi.waitFor(() => expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines).toHaveLength(73));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "sys.ledger.list", { limit: INSTRUMENT_LEDGER_PAGE, cursor: "gap" }, { signal: expect.any(AbortSignal) });
    const current = cache.getQueryData<LedgerPages>(KEY)!;
    expect(current.pages[0].lines.map((line) => line.id)).toEqual(Array.from({ length: 73 }, (_, i) => `sys:${81 - i}`));
    expect(current.pages[0].nextCursor).toBe("older");
  });

  it("does not prepend previously unloaded older history when a catch-up page extends past the cached head", async () => {
    const { sync, request, cache } = setup();
    request.mockResolvedValueOnce({ data: page([12, 11, 10, 9, 8, 7]) });
    sync.appended(11);
    await vi.waitFor(() => expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines).toHaveLength(4));
    expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines.map((line) => line.id)).toEqual(["sys:12", "sys:11", "sys:10", "sys:9"]);
  });

  it("marks an inactive ledger stale without issuing background reads", async () => {
    const { sync, request, cache, close } = setup();
    close();
    sync.appended(11); sync.appended(12);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(cache.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it("cancels catch-up when the ledger closes and ignores a late response", async () => {
    const { sync, request, cache, close } = setup();
    const reply = deferred<{ data: SysLedgerListResult }>();
    request.mockReturnValueOnce(reply.promise);
    sync.appended(11);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const signal = request.mock.calls[0][2]?.signal;
    close();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    reply.resolve({ data: page([12, 11, 10]) });
    await Promise.resolve(); await Promise.resolve();
    expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines[0].id).toBe("sys:10");
    expect(cache.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it("stops and cancels work when the connection or session is replaced", async () => {
    const { sync, request, cache } = setup();
    const reply = deferred<{ data: SysLedgerListResult }>();
    request.mockReturnValueOnce(reply.promise);
    sync.appended(11);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    sync.stop();
    expect(request.mock.calls[0][2]?.signal?.aborted).toBe(true);
    cache.setQueryData(KEY, pages([50]));
    reply.resolve({ data: page([12, 11, 10]) });
    await Promise.resolve(); await Promise.resolve();
    expect(cache.getQueryData<LedgerPages>(KEY)?.pages[0].lines.map((line) => line.id)).toEqual(["sys:50"]);
  });

  it("falls back to the observed query so read errors are visible, without retrying indefinitely", async () => {
    const load = vi.fn(async (): Promise<LedgerPages> => { throw new Error("offline"); });
    const { sync, request, cache } = setup(pages([10]), load);
    request.mockRejectedValueOnce(new Error("offline"));
    sync.appended(11);
    await vi.waitFor(() => expect(cache.getQueryState(KEY)?.status).toBe("error"));
    expect(request).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });
});
