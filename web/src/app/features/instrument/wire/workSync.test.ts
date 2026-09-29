import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import { describe, expect, it, vi } from "vitest";
import { syncWorkSignal } from "./workSync";
import { INSTRUMENT_RESPONSIBILITIES_KEY, INSTRUMENT_ROUTINES_KEY, INSTRUMENT_SOURCES_KEY } from "./queryKeys";

describe("work notifications", () => {
  it.each([
    ["r12y.changed", [...INSTRUMENT_RESPONSIBILITIES_KEY, "current"]],
    ["sched.changed", INSTRUMENT_ROUTINES_KEY],
    ["r12y.source.changed", INSTRUMENT_SOURCES_KEY],
  ] as const)("retires an older in-flight snapshot on %s and defers closed readers", async (signal, key) => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let resolve!: (value: string[]) => void;
    const old = new Promise<string[]>((done) => { resolve = done; });
    const read = vi.fn().mockImplementationOnce(() => old).mockResolvedValue(["current"]);
    const observer = new QueryObserver(cache, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      cache.setQueryData(["unrelated"], ["keep"]);
      await syncWorkSignal(cache, signal);
      resolve(["old"]);
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(2);
      expect(cache.getQueryData(key)).toEqual(["current"]);
      expect(cache.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
      unsubscribe();
      await syncWorkSignal(cache, signal);
      expect(read).toHaveBeenCalledTimes(2);
      expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    } finally { unsubscribe(); cache.clear(); }
  });
});
