import { QueryClient } from "@tanstack/preact-query";
import type { GSVClient, GsvClientStatus } from "@humansandmachines/gsv/client";
import { describe, expect, it, vi } from "vitest";
import { watchGatewayQueries } from "./GatewaySignalInvalidator";

describe("gateway query recovery", () => {
  it("invalidates fresh caches once per reconnect and retains scoped signal updates", async () => {
    const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const conversation = ["conversation", "history", "ship"];
    queries.setQueryData(conversation, { messages: ["before disconnect"] });
    queries.setQueryData(["devices"], []);
    const invalidate = vi.spyOn(queries, "invalidateQueries");
    let status: GsvClientStatus = { state: "connected", connectionId: "first", url: "wss://example.test/ws", username: "alice", message: null };
    let onStatus: Parameters<GSVClient["onStatus"]>[0] = () => {};
    let onSignal: Parameters<GSVClient["onSignal"]>[0] = () => {};
    const stopStatus = vi.fn(), stopSignals = vi.fn();
    const client = { getStatus: () => status, onStatus: (listener: Parameters<GSVClient["onStatus"]>[0]) => { onStatus = listener; listener(status); return stopStatus; },
      onSignal: (listener: Parameters<GSVClient["onSignal"]>[0]) => { onSignal = listener; return stopSignals; } };
    const stop = watchGatewayQueries(client, queries);
    try {
      expect(invalidate).not.toHaveBeenCalled();
      onStatus({ ...status, state: "disconnected", connectionId: null });
      status = { ...status, connectionId: "second" };
      onStatus(status);
      onStatus(status);
      expect(invalidate).toHaveBeenCalledExactlyOnceWith();
      expect(queries.getQueryState(conversation)?.isInvalidated).toBe(true);
      onSignal("target.status", { targetId: "gsv", event: "connected", timestamp: Date.now() });
      expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ["devices"] });
    } finally {
      stop();
      expect(stopStatus).toHaveBeenCalledOnce();
      expect(stopSignals).toHaveBeenCalledOnce();
      queries.clear();
    }
  });
});
