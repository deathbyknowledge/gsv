import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import { procHistoryRecordSchema, type ProcHistoryRecordsResult } from "@humansandmachines/gsv/protocol";
import { GatewayProvider } from "../../gateway/GatewayProvider";
import { createTestRoot } from "../../../testing/testHarness";
import { useChatRuntime } from "./useChatRuntime";

type ObservedRuntime = { current?: ReturnType<typeof useChatRuntime> };

function page(ids: number[], revision: number, hasMoreBefore: boolean): ProcHistoryRecordsResult {
  return {
    ok: true, pid: "p", format: 2, messages: [], messageCount: 6,
    records: ids.map((id) => procHistoryRecordSchema.parse({
      id, messageId: id, index: 0, generation: 1, runId: null, createdAt: id, source: "typed",
      kind: "message", payload: { direction: "in", text: `message ${id}`, media: [], origin: {} },
    })),
    cursor: `c${revision}`, historyRevision: revision, historyGeneration: 1, historyResetRevision: 0,
    hasMoreBefore, hasMore: false, reset: false,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("process history pagination through the runtime hook", () => {
  it("fetches every intervening page after an older group arrives in a delta", async () => {
    vi.stubGlobal("document", {});
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const listeners = new Set<Parameters<GSVClient["onSignal"]>[0]>();
    vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    const request = vi.spyOn(GSVClient.prototype, "request")
      .mockResolvedValueOnce({ data: page([5, 6], 6, true) })
      .mockResolvedValueOnce({ data: page([1], 7, false) })
      .mockResolvedValueOnce({ data: page([3, 4], 7, true) })
      .mockResolvedValueOnce({ data: page([1, 2], 7, false) });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createTestRoot("Process history pagination");
    const observed: ObservedRuntime = {};
    function Harness() { observed.current = useChatRuntime({ processId: "p", historyLimit: 2 }); return null; }
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(observed.current?.runtime.rows).toHaveLength(2));
      await act(async () => {
        for (const listener of listeners) listener("proc.changed", { pid: "p", changes: ["messages"], historyRevision: 7 });
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(observed.current?.runtime.rows).toHaveLength(3));
      await act(async () => { await observed.current?.loadOlderHistory(); });
      expect(request.mock.calls[2]).toEqual(["proc.history", { pid: "p", beforeMessageId: 5, limit: 50, format: 2 }]);
      await vi.waitFor(() => expect(observed.current?.runtime.rows).toHaveLength(5));
      await act(async () => { await observed.current?.loadOlderHistory(); });
      expect(request.mock.calls[3]).toEqual(["proc.history", { pid: "p", beforeMessageId: 3, limit: 50, format: 2 }]);
      await vi.waitFor(() => expect(observed.current?.hasOlderHistory).toBe(false));
      expect(observed.current?.runtime.rows.map(({ messageId }) => messageId)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      await root.unmount();
      cache.clear();
    }
  });
});
