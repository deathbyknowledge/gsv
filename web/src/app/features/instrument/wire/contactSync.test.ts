import { instrumentContactConversationKey, instrumentContactRequestsKey } from "./queryKeys";
import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../testing/testHarness";
import { refreshContactQuery, syncContactDetailSignal } from "./contactSync";
import { INSTRUMENT_CONTACTS_KEY as KEY, INSTRUMENT_CONTACT_INVITES_KEY as INVITES } from "./queryKeys";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function setup(initial: string[] | undefined, load: () => Promise<string[]>) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cleanup.push(() => cache.clear());
  if (initial) cache.setQueryData(KEY, initial);
  const observer = new QueryObserver(cache, { queryKey: KEY, queryFn: load });
  const unsubscribe = observer.subscribe(() => undefined);
  cleanup.push(unsubscribe);
  return { cache, unsubscribe };
}

describe("contact change notifications", () => {
  it("refreshes only the affected list", async () => {
    const load = vi.fn(async () => ["new contact"]);
    const { cache } = setup([], load);
    cache.setQueryData(INVITES, ["pending"]);
    await refreshContactQuery(cache, KEY);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getQueryData(KEY)).toEqual(["new contact"]);
    expect(cache.getQueryState(INVITES)?.isInvalidated).toBe(false);
  });

  it.each([{ initial: undefined }, { initial: ["existing"] }])("cannot lose a change behind an older snapshot ($initial)", async ({ initial }) => {
    const older = deferred<string[]>();
    const load = vi.fn().mockImplementationOnce(() => older.promise).mockResolvedValue(["new contact"]);
    const { cache } = setup(initial, load);
    if (initial) void cache.refetchQueries({ queryKey: KEY });
    expect(load).toHaveBeenCalledOnce();
    await refreshContactQuery(cache, KEY);
    older.resolve([]);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(KEY)).toEqual(["new contact"]);
  });

  it("marks a closed list stale without reading it in the background", async () => {
    const load = vi.fn(async () => ["new contact"]);
    const { cache, unsubscribe } = setup([], load);
    unsubscribe();
    await refreshContactQuery(cache, KEY);
    expect(load).not.toHaveBeenCalled();
    expect(cache.getQueryState(KEY)?.isInvalidated).toBe(true);
  });
});


describe("contact detail notifications", () => {
  it.each([
    ["conversation.changed", instrumentContactConversationKey("one"), { conversationId: "one", latestSequence: 2 }],
    ["contact.request.changed", instrumentContactRequestsKey("one"), { contactId: "one" }],
  ] as const)("refreshes only an observed detail on %s and defers closed ones", async (signal, key, payload) => {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    cleanup.push(() => cache.clear());
    const older = deferred<string[]>();
    const load = vi.fn().mockImplementationOnce(() => older.promise).mockResolvedValue(["new record"]);
    const observer = new QueryObserver(cache, { queryKey: key, queryFn: load });
    const unsubscribe = observer.subscribe(() => undefined);
    cleanup.push(unsubscribe);
    const unrelated = [...key.slice(0, -1), "two"];
    cache.setQueryData(unrelated, ["other"]);
    await syncContactDetailSignal(cache, signal, payload);
    older.resolve(["stale"]);
    await Promise.resolve();
    expect(cache.getQueryData(key)).toEqual(["new record"]);
    expect(cache.getQueryState(unrelated)?.isInvalidated).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    unsubscribe();
    await syncContactDetailSignal(cache, signal, payload);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    const count = cache.getQueryCache().getAll().length;
    await syncContactDetailSignal(cache, signal, { contactId: "unopened", conversationId: "unopened" });
    await syncContactDetailSignal(cache, signal, { contactId: 12, conversationId: null });
    expect(cache.getQueryCache().getAll()).toHaveLength(count);
  });
});
