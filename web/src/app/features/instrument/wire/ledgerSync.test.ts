import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/preact-query";
import type { SysLedgerLine } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../gsv-console/messengers/messengerTestHarness";
import { ledgerFromSysLines } from "../fleet/fleetModel";
import { createLedgerSync, LEDGER_PENDING_LIMIT } from "./ledgerSync";
import { INSTRUMENT_LEDGER_KEY } from "./queryKeys";
import type { LedgerPages } from "./wireModel";

const KEY = [...INSTRUMENT_LEDGER_KEY, "sys"];
function lines(sequences: number[], outcome: SysLedgerLine["outcome"] = "ok"): SysLedgerLine[] {
  return sequences.map((seq) => ({
    seq, timestamp: seq, principalKind: "human", uid: 1000, pid: null, runId: null,
    target: "gsv", call: "account.list", args: "{}", outcome, durationMs: outcome === null ? null : 1,
  }));
}
function pages(sequences: number[], outcome: SysLedgerLine["outcome"] = "ok"): LedgerPages {
  return { pages: [{ lines: ledgerFromSysLines(lines(sequences, outcome)), nextCursor: "older" }], pageParams: [null] };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function setup(initial: LedgerPages | null = pages([10, 9]), load = vi.fn(async () => pages([10, 9]))) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cleanup.push(() => cache.clear());
  if (initial) cache.setQueryData(KEY, initial);
  const sync = createLedgerSync(cache);
  cleanup.push(sync.stop);
  const observer = new QueryObserver(cache, { queryKey: KEY, queryFn: load });
  let unsubscribe = observer.subscribe(() => undefined);
  const close = () => { unsubscribe(); unsubscribe = () => undefined; };
  cleanup.push(close);
  const current = () => cache.getQueryData<LedgerPages>(KEY)!;
  return { cache, sync, observer, close, load, current };
}

describe("live ledger patches", () => {
  it("inserts new rows and patches completion and usage without requesting a list", async () => {
    const { sync, load, current } = setup();
    sync.changed(lines([11], null));
    await Promise.resolve();
    expect(current().pages[0].lines[0]).toMatchObject({ id: "sys:11", outcome: "running" });
    sync.changed([{ ...lines([11])[0], costNanoUsd: 42 }]);
    await Promise.resolve();
    expect(current().pages[0].lines.map((line) => line.id)).toEqual(["sys:11", "sys:10", "sys:9"]);
    expect(current().pages[0].lines[0]).toMatchObject({ outcome: "completed", costNanoUsd: 42 });
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps completion received before the initial snapshot, including the read's own row", async () => {
    const initial = deferred<LedgerPages>();
    const { sync, current, load } = setup(null, vi.fn(() => initial.promise));
    sync.changed(lines([10]));
    initial.resolve(pages([10, 9], null));
    await vi.waitFor(() => expect(current()?.pages[0].lines[0].outcome).toBe("completed"));
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps rows appended after an in-flight snapshot without fetching again", async () => {
    const initial = deferred<LedgerPages>();
    const { sync, current, load } = setup(null, vi.fn(() => initial.promise));
    sync.changed(lines([11]));
    initial.resolve(pages([10, 9]));
    await vi.waitFor(() => expect(current()?.pages[0].lines[0].id).toBe("sys:11"));
    expect(load).toHaveBeenCalledOnce();
    expect(current().pages[0].nextCursor).toBe("older");
  });

  it("orders delayed owner batches against the snapshot instead of dropping rows below the live head", async () => {
    const { sync, current, load } = setup();
    sync.changed(lines([13, 12]));
    await Promise.resolve();
    sync.changed(lines([11]));
    await Promise.resolve();
    expect(current().pages[0].lines.map((line) => line.id)).toEqual(["sys:13", "sys:12", "sys:11", "sys:10", "sys:9"]);
    expect(load).not.toHaveBeenCalled();
  });

  it("patches older loaded pages but does not insert unloaded old completions above the head", async () => {
    const initial = pages([10, 9]);
    initial.pages.push({ lines: ledgerFromSysLines(lines([8, 7], null)), nextCursor: "oldest" });
    initial.pageParams.push("older");
    const { sync, current } = setup(initial);
    sync.changed(lines([8, 6]));
    await Promise.resolve();
    expect(current().pages[0].lines.map((line) => line.id)).toEqual(["sys:10", "sys:9"]);
    expect(current().pages[1].lines.map((line) => [line.id, line.outcome])).toEqual([["sys:8", "completed"], ["sys:7", "running"]]);
    expect(current().pageParams).toEqual([null, "older"]);
    expect(current().pages[1].nextCursor).toBe("oldest");
  });

  it("does not regress a terminal outcome when an older open patch arrives", async () => {
    const { sync, current } = setup();
    sync.changed(lines([11])); sync.changed(lines([11], null));
    await Promise.resolve();
    sync.changed(lines([11], null));
    await Promise.resolve();
    expect(current().pages[0].lines[0].outcome).toBe("completed");
  });

  it("reapplies patches after a manual refresh overwrites the cached snapshot", async () => {
    const fetched = deferred<LedgerPages>();
    const { sync, observer, current, load } = setup(pages([10, 9], null), vi.fn(() => fetched.promise));
    const refresh = observer.refetch();
    sync.changed(lines([11, 10]));
    fetched.resolve(pages([10, 9], null));
    await refresh;
    await vi.waitFor(() => expect(current().pages[0].lines[0].id).toBe("sys:11"));
    expect(current().pages[0].lines.slice(0, 2).map((line) => line.outcome)).toEqual(["completed", "completed"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps delayed new rows while paging older history without advancing the snapshot boundary", async () => {
    const older = deferred<LedgerPages["pages"][number]>();
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    cleanup.push(() => cache.clear());
    cache.setQueryData(KEY, pages([10, 9]));
    const sync = createLedgerSync(cache); cleanup.push(sync.stop);
    const load = vi.fn(() => older.promise);
    const observer = new InfiniteQueryObserver(cache, {
      queryKey: KEY, queryFn: load, initialPageParam: null as string | null, getNextPageParam: (page) => page.nextCursor,
    });
    cleanup.push(observer.subscribe(() => undefined));
    sync.changed(lines([13]));
    await Promise.resolve();
    const nextPage = observer.fetchNextPage();
    sync.changed(lines([12, 11]));
    older.resolve({ lines: ledgerFromSysLines(lines([8, 7])), nextCursor: "oldest" });
    await nextPage;
    await Promise.resolve();
    const current = cache.getQueryData<LedgerPages>(KEY)!;
    expect(current.pages[0].lines.map((line) => line.id)).toEqual(["sys:13", "sys:12", "sys:11", "sys:10", "sys:9"]);
    expect(current.pages[1].lines.map((line) => line.id)).toEqual(["sys:8", "sys:7"]);
    expect(current.pageParams).toEqual([null, "older"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("marks a hidden ledger stale, then refreshes once when it is opened", async () => {
    const { sync, cache, close, load, observer } = setup();
    close(); sync.changed(lines([11]));
    await Promise.resolve();
    expect(cache.getQueryState(KEY)?.isInvalidated).toBe(true);
    expect(load).not.toHaveBeenCalled();
    const stop = observer.subscribe(() => undefined); cleanup.push(stop);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  });

  it("drops queued patches when the query is removed or the connection stops", async () => {
    const { sync, cache, current } = setup();
    sync.changed(lines([11]));
    cache.removeQueries({ queryKey: KEY, exact: true });
    cache.setQueryData(KEY, pages([50]));
    await Promise.resolve();
    expect(current().pages[0].lines.map((line) => line.id)).toEqual(["sys:50"]);
    sync.stop(); sync.changed(lines([51]));
    await Promise.resolve();
    expect(current().pages[0].lines[0].id).toBe("sys:50");
  });

  it("bounds patches during a stalled fetch and recovers once from an authoritative snapshot", async () => {
    const initial = deferred<LedgerPages>();
    const load = vi.fn(() => initial.promise).mockImplementationOnce(() => initial.promise)
      .mockResolvedValueOnce(pages([1000, 999]));
    const { sync, current } = setup(null, load);
    sync.changed(lines(Array.from({ length: LEDGER_PENDING_LIMIT + 1 }, (_, i) => i + 11)));
    initial.resolve(pages([10, 9]));
    await vi.waitFor(() => expect(current()?.pages[0].lines[0].id).toBe("sys:1000"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves a failed initial read visible instead of inventing a partial ledger or retrying", async () => {
    const initial = deferred<void>();
    const { sync, cache, load } = setup(null, vi.fn(async (): Promise<LedgerPages> => { await initial.promise; throw new Error("offline"); }));
    sync.changed(lines([11]));
    initial.resolve();
    await vi.waitFor(() => expect(cache.getQueryState(KEY)?.status).toBe("error"));
    expect(cache.getQueryData(KEY)).toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
  });
});
