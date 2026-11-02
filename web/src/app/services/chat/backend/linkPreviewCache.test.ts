import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LINK_PREVIEW_FAILURE_KEEP_MS,
  LINK_PREVIEW_KEEP_MS,
  LinkPreviewCache,
  LinkPreviewUnavailableError,
  MAX_LINK_PREVIEW_ENTRIES,
} from "./linkPreviewCache";
import type { LinkPreviewCacheEntry, LinkPreviewCacheStore } from "./linkPreviewCache";

function memoryStore() {
  const entries = new Map<string, LinkPreviewCacheEntry>();
  const store: LinkPreviewCacheStore = {
    get: async (key) => entries.get(key),
    put: async (entry) => { entries.set(entry.key, entry); },
    prune: vi.fn(async (before: number, keep: number) => {
      const oldest = [...entries.values()].sort((left, right) => left.storedAt - right.storedAt);
      for (const entry of oldest) {
        if (entry.storedAt >= before && entries.size <= keep) break;
        entries.delete(entry.key);
      }
    }),
  };
  return { entries, store };
}

const asString = z.string();

describe("link preview cache", () => {
  it("serves a kept read until it is a week old, then reads again", async () => {
    let now = 1_000;
    const { store } = memoryStore();
    const cache = new LinkPreviewCache(async () => store, () => now);
    const fetch = vi.fn(async () => `read at ${now}`);

    await expect(cache.read("page:a", asString, fetch)).resolves.toBe("read at 1000");
    now += LINK_PREVIEW_KEEP_MS - 1;
    await expect(cache.read("page:a", asString, fetch)).resolves.toBe("read at 1000");
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(cache.read("page:a", asString, fetch)).resolves.toBe(`read at ${now}`);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("remembers a page with nothing to show for an hour, but not a lost connection", async () => {
    let now = 0;
    const { entries, store } = memoryStore();
    const cache = new LinkPreviewCache(async () => store, () => now);
    const unavailable = vi.fn(async (): Promise<string> => { throw new LinkPreviewUnavailableError("not HTML"); });

    await expect(cache.read("page:a", asString, unavailable)).rejects.toBeInstanceOf(LinkPreviewUnavailableError);
    await expect(cache.read("page:a", asString, unavailable)).rejects.toBeInstanceOf(LinkPreviewUnavailableError);
    expect(unavailable).toHaveBeenCalledTimes(1);
    now += LINK_PREVIEW_FAILURE_KEEP_MS;
    await expect(cache.read("page:a", asString, async () => "back")).resolves.toBe("back");

    await expect(cache.read("page:b", asString, async () => { throw new Error("disconnected"); })).rejects.toThrow("disconnected");
    expect(entries.has("page:b")).toBe(false);
  });

  it("reads afresh when a kept value is not one this version recognises", async () => {
    const { store } = memoryStore();
    await store.put({ key: "page:a", storedAt: 0, value: { title: "kept by an older version" } });
    const cache = new LinkPreviewCache(async () => store, () => 0);
    await expect(cache.read("page:a", asString, async () => "new")).resolves.toBe("new");
  });

  it("prunes after every write, dropping old entries and the oldest beyond the bound", async () => {
    const now = LINK_PREVIEW_KEEP_MS * 2;
    const { entries, store } = memoryStore();
    await store.put({ key: "page:stale", storedAt: now - LINK_PREVIEW_KEEP_MS - 1, value: "stale" });
    for (let index = 0; index < MAX_LINK_PREVIEW_ENTRIES; index += 1) {
      await store.put({ key: `page:${index}`, storedAt: now - 1_000 + index, value: String(index) });
    }
    const cache = new LinkPreviewCache(async () => store, () => now);

    await cache.read("page:5", asString, async () => "unused");
    expect(store.prune).not.toHaveBeenCalled();
    await cache.read("page:new", asString, async () => "new");
    expect(entries.has("page:stale")).toBe(false);
    expect(entries.has("page:0")).toBe(false);
    expect(entries.size).toBe(MAX_LINK_PREVIEW_ENTRIES);
    await cache.read("page:newer", asString, async () => "newer");
    expect(store.prune).toHaveBeenCalledTimes(2);
    expect(entries.has("page:1")).toBe(false);
    expect(entries.size).toBe(MAX_LINK_PREVIEW_ENTRIES);
  });

  it("keeps a read that was under way when the cache was cleared to itself", async () => {
    const { entries, store } = memoryStore();
    const cache = new LinkPreviewCache(async () => store);
    let finish!: (value: string) => void;
    const reading = cache.read("page:a", asString, () => new Promise<string>((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    cache.fence();
    finish("the previous person's page");
    await expect(reading).resolves.toBe("the previous person's page");
    expect(entries.has("page:a")).toBe(false);

    await cache.read("page:b", asString, async () => "after");
    expect(entries.has("page:b")).toBe(true);
  });

  it("reads the page when the browser keeps nothing", async () => {
    const failing: LinkPreviewCacheStore = {
      get: async () => { throw new Error("quota"); },
      put: async () => { throw new Error("quota"); },
      prune: async () => { throw new Error("quota"); },
    };
    await expect(new LinkPreviewCache(async () => failing).read("page:a", asString, async () => "read")).resolves.toBe("read");
    await expect(new LinkPreviewCache(async () => null).read("page:a", asString, async () => "read")).resolves.toBe("read");
  });
});
