import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import { describe, expect, it, vi } from "vitest";
import { syncInstanceSignal } from "./instanceSync";
import { INSTANCE_QUERY_KEY, INSTRUMENT_TARGETS_KEY } from "./queryKeys";

describe("cloud instance notifications", () => {
  it.each([INSTANCE_QUERY_KEY, INSTRUMENT_TARGETS_KEY, ["cloud-instance", "browser-id"]].map(key => ({ key })))("refreshes $key and rejects a snapshot started before the notification", async ({ key }) => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let resolve!: (value: string[]) => void;
    const old = new Promise<string[]>(done => { resolve = done; });
    const read = vi.fn().mockImplementationOnce(() => old).mockResolvedValue(["current"]);
    const observer = new QueryObserver(cache, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    try {
      cache.setQueryData(["unrelated"], ["keep"]);
      await syncInstanceSignal(cache);
      resolve(["old"]);
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(2);
      expect(cache.getQueryData(key)).toEqual(["current"]);
      expect(cache.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
      unsubscribe();
      await syncInstanceSignal(cache);
      expect(read).toHaveBeenCalledTimes(2);
      expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    } finally { unsubscribe(); cache.clear(); }
  });
  it("updates Zen's targets when Fleet and the browser viewer have never opened", async () => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    let targets = ["gsv"];
    const read = vi.fn(async () => targets);
    const observer = new QueryObserver(cache, { queryKey: INSTRUMENT_TARGETS_KEY, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(cache.getQueryData(INSTRUMENT_TARGETS_KEY)).toEqual(["gsv"]));
      targets = ["gsv", "browser"];
      await syncInstanceSignal(cache);
      expect(cache.getQueryData(INSTRUMENT_TARGETS_KEY)).toEqual(targets);
      expect(cache.getQueryState(INSTANCE_QUERY_KEY)).toBeUndefined();
      expect(cache.getQueryCache().findAll({ queryKey: ["cloud-instance"] })).toEqual([]);
    } finally { unsubscribe(); cache.clear(); }
  });
});
