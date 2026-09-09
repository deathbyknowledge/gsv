import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/preact-query";
import type { LibraryEntry, LibraryNote } from "../../gsv-console/library/libraryTypes";
import { INSTRUMENT_MEMORY_KEY } from "../wire/queryKeys";
import { refreshSavedMemoryPage } from "./memoryQueries";
import type { MemorySearchResult } from "./memoryService";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
const pageKey = [...INSTRUMENT_MEMORY_KEY, "page", "personal", "personal/pages/example.md"];
const pagesKey = [...INSTRUMENT_MEMORY_KEY, "pages", "personal"];
const searchKey = [...INSTRUMENT_MEMORY_KEY, "search", "personal", "example"];
const oldNote: LibraryNote = { path: "personal/pages/example.md", title: "Old title", markdown: "# Old title\n\nOld text." };
const saved = { db: "personal", path: oldNote.path, markdown: "# New title\n\nSaved text." };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => queryClient.clear());

describe("Memory save cache refresh", () => {
  it("keeps a saved page and invalidated search/list caches when pre-save requests finish after navigation", async () => {
    const read = deferred<LibraryNote>();
    const search = deferred<MemorySearchResult>();
    const list = deferred<LibraryEntry[]>();
    const originalSearch: MemorySearchResult = { entries: [], truncated: false };
    queryClient.setQueryData(pageKey, oldNote);
    queryClient.setQueryData(searchKey, originalSearch);
    queryClient.setQueryData(pagesKey, []);
    const observers = [
      new QueryObserver(queryClient, { queryKey: pageKey, queryFn: () => read.promise, staleTime: 0 }),
      new QueryObserver(queryClient, { queryKey: searchKey, queryFn: () => search.promise, staleTime: 0 }),
      new QueryObserver(queryClient, { queryKey: pagesKey, queryFn: () => list.promise, staleTime: 0 }),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    for (const key of [pageKey, searchKey, pagesKey]) {
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching");
    }
    unsubscribe.forEach((stop) => stop());
    for (const key of [pageKey, searchKey, pagesKey]) {
      expect(queryClient.getQueryCache().find({ queryKey: key })?.isActive()).toBe(false);
    }

    await refreshSavedMemoryPage(queryClient, saved);
    read.resolve(oldNote);
    const staleEntry: LibraryEntry = { kind: "file", path: oldNote.path, title: oldNote.title };
    search.resolve({ entries: [staleEntry], truncated: false });
    list.resolve([staleEntry]);
    await Promise.all([read.promise, search.promise, list.promise]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData(pageKey)).toEqual({ path: saved.path, title: "New title", markdown: saved.markdown });
    expect(queryClient.getQueryData(searchKey)).toEqual(originalSearch);
    expect(queryClient.getQueryData(pagesKey)).toEqual([]);
    for (const key of [pageKey, searchKey, pagesKey]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(key)?.fetchStatus).toBe("idle");
    }
  });

  it("does not cancel a different collection's pending read", async () => {
    const otherKey = [...INSTRUMENT_MEMORY_KEY, "page", "shared", "shared/pages/example.md"];
    const otherNote: LibraryNote = { path: "shared/pages/example.md", title: "Shared", markdown: "Shared content." };
    const read = deferred<LibraryNote>();
    const observer = new QueryObserver(queryClient, { queryKey: otherKey, queryFn: () => read.promise });
    const unsubscribe = observer.subscribe(() => {});
    unsubscribe();

    await refreshSavedMemoryPage(queryClient, saved);
    expect(queryClient.getQueryState(otherKey)?.fetchStatus).toBe("fetching");
    read.resolve(otherNote);
    await read.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queryClient.getQueryData(otherKey)).toEqual(otherNote);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it("refetches an active saved page after retiring its earlier read", async () => {
    const oldRead = deferred<LibraryNote>();
    const savedNote: LibraryNote = { path: saved.path, title: "New title", markdown: saved.markdown };
    let reads = 0;
    queryClient.setQueryData(pageKey, oldNote);
    const observer = new QueryObserver(queryClient, {
      queryKey: pageKey,
      staleTime: 0,
      queryFn: () => ++reads === 1 ? oldRead.promise : Promise.resolve(savedNote),
    });
    const unsubscribe = observer.subscribe(() => {});

    await refreshSavedMemoryPage(queryClient, saved);
    oldRead.resolve(oldNote);
    await oldRead.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reads).toBe(2);
    expect(queryClient.getQueryData(pageKey)).toEqual(savedNote);
    expect(queryClient.getQueryState(pageKey)?.isInvalidated).toBe(false);
    unsubscribe();
  });
});
