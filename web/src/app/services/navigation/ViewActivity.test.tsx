import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot } from "../../testing/testHarness";
import { RetainedView, useViewSnapshot } from "./ViewActivity";
import { useQuery } from "./viewQueries";

// Keep the real view lifetime and context, without rendering browser DOM in this hook harness.
function View({ active, children }: { active: boolean; children: ComponentChildren }) {
  return RetainedView({ active, children }).props.children;
}

beforeEach(() => {
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("retained Instrument views", () => {
  it("opens lazily and preserves a draft until its signed-in owner is torn down", async () => {
    const root = createTestRoot("retained draft");
    const mounted = vi.fn();
    const disposed = vi.fn();
    let draft = "";
    let edit = (_value: string) => {};
    function Page() {
      const [value, setValue] = useState("");
      draft = value;
      edit = setValue;
      useEffect(() => { mounted(); return disposed; }, []);
      return null;
    }
    try {
      await root.render(<View active={false}><Page /></View>);
      expect(mounted).not.toHaveBeenCalled();
      await root.render(<View active><Page /></View>);
      await act(() => edit("Unsent local draft"));
      await root.render(<View active={false}><Page /></View>);
      await root.render(<View active><Page /></View>);
      expect(draft).toBe("Unsent local draft");
      expect(mounted).toHaveBeenCalledTimes(1);
      expect(disposed).not.toHaveBeenCalled();
    } finally { await root.unmount(); }
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("merges every live update while hidden without rendering and publishes them on return", async () => {
    const root = createTestRoot("hidden live state");
    let renders = 0;
    let shown: number[] = [];
    let receive = (_value: number) => {};
    function Page() {
      const [value, update] = useViewSnapshot<number[]>([]);
      renders++;
      shown = value;
      receive = (next) => update((previous) => [...previous, next]);
      return null;
    }
    try {
      await root.render(<View active><Page /></View>);
      await act(() => receive(1));
      await root.render(<View active={false}><Page /></View>);
      const before = renders;
      await act(() => { receive(2); receive(3); });
      expect(renders).toBe(before);
      expect(shown).toEqual([1]);
      await root.render(<View active><Page /></View>);
      expect(shown).toEqual([1, 2, 3]);
    } finally { await root.unmount(); }
  });

  it("keeps hidden cache entries while suppressing UI updates and invalidation reads", async () => {
    const root = createTestRoot("hidden queries");
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const queryKey = ["retained-view"];
    cache.setQueryData(queryKey, 1);
    const fetch = vi.fn(async () => 3);
    let renders = 0;
    let shown: number | undefined;
    function Page() {
      const query = useQuery({ queryKey, queryFn: fetch });
      renders++;
      shown = query.data;
      return null;
    }
    const render = (active: boolean) => root.render(<QueryClientProvider client={cache}><View active={active}><Page /></View></QueryClientProvider>);
    try {
      await render(true);
      expect(shown).toBe(1);
      await render(false);
      const before = renders;
      await act(async () => {
        cache.setQueryData(queryKey, 2);
        await cache.invalidateQueries({ queryKey });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(cache.getQueryData(queryKey)).toBe(2);
      expect(cache.getQueryCache().find({ queryKey })?.isActive()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(renders).toBe(before);
      await render(true);
      await vi.waitFor(() => expect(shown).toBe(3));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await root.unmount(); cache.clear(); }
  });
});
