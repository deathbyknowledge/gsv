import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../gsv-console/messengers/messengerTestHarness";
import { refreshMessengerConnections } from "./messengerSync";
import { INSTRUMENT_MESSENGERS_KEY, INSTRUMENT_LEDGER_KEY } from "./queryKeys";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const key = [...INSTRUMENT_MESSENGERS_KEY, 1000];

function observe(load: () => Promise<string[]>, enabled = true) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cleanup.push(() => cache.clear());
  const observer = new QueryObserver(cache, { queryKey: key, queryFn: load, enabled });
  cleanup.push(observer.subscribe(() => undefined));
  return { cache, observer };
}

describe("messenger status synchronization", () => {
  it("discards a stale initial identity read after another client unlinks", async () => {
    const older = deferred<string[]>();
    const load = vi.fn().mockImplementationOnce(() => older.promise).mockResolvedValue([]);
    const { cache } = observe(load);
    cache.setQueryData(INSTRUMENT_LEDGER_KEY, ["existing activity"]);
    await refreshMessengerConnections(cache);
    older.resolve(["old linked identity"]);
    await Promise.resolve();
    expect(cache.getQueryData(key)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getQueryState(INSTRUMENT_LEDGER_KEY)?.isInvalidated).toBe(false);
  });

  it("waits to read while the integrations section is hidden", async () => {
    const load = vi.fn(async () => ["linked elsewhere"]);
    const { cache, observer } = observe(load, false);
    cache.setQueryData(key, []);
    await refreshMessengerConnections(cache);
    expect(load).not.toHaveBeenCalled();
    expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    observer.setOptions({ queryKey: key, queryFn: load, enabled: true });
    await vi.waitFor(() => expect(cache.getQueryData(key)).toEqual(["linked elsewhere"]));
    expect(load).toHaveBeenCalledOnce();
  });

  it("retains the saved identity and exposes a refresh failure", async () => {
    const load = vi.fn(async (): Promise<string[]> => { throw new Error("Service is unavailable"); });
    const { cache, observer } = observe(load, false);
    cache.setQueryData(key, ["existing identity"]);
    observer.setOptions({ queryKey: key, queryFn: load, enabled: true });
    await refreshMessengerConnections(cache);
    expect(cache.getQueryData(key)).toEqual(["existing identity"]);
    expect(cache.getQueryState(key)?.error?.message).toBe("Service is unavailable");
  });
});
