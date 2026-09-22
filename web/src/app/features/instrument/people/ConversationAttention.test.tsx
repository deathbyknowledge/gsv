import { GSVClient } from "@humansandmachines/gsv/client";
import type { ApproachListResult, ApproachSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { INSTRUMENT_APPROACHES_KEY } from "../wire/queryKeys";
import { refreshContactQuery } from "../wire/contactSync";
import { ConversationAttention } from "./ConversationAttention";
import { useAttentionSummary } from "./useAttentionSummary";

const account: ConsoleAccount = { uid: 1000, username: "person", displayName: "Person", relation: "self", runnable: false, gecos: "",
  capabilities: ["conversation.attention.list", "approach.list"] };
const request: ApproachSummary = {
  id: "approach:hello", direction: "incoming", state: "pending", revision: 1,
  reference: { actor: { shipId: "ship:visitor", subjectId: "subject:visitor" }, approachId: "approach:hello" },
  peer: { shipId: "ship:visitor", subjectId: "subject:visitor" }, displayName: "A visitor",
  conversationId: "conversation:hello", messageSequence: 1, delivery: "received", createdAtMs: 1000, updatedAtMs: 1000, expiresAtMs: 9_999_999,
};
const loadRequests = vi.fn<() => Promise<ApproachListResult>>();
beforeEach(() => {
  loadRequests.mockReset();
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { location: { protocol: "https:", host: "space.example" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "person", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockReturnValue(() => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "conversation.attention.list") return { data: { entries: [], readyCount: 0, digestWaitingCount: 0 } };
    if (call === "approach.list") return { data: await loadRequests() };
    throw new Error(`Unexpected request ${call}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mounted() {
  const root = createTestRoot("social attention");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  cache.setQueryData(["fleet", "accounts"], [account]);
  const onOpenRequest = vi.fn();
  let tree: ComponentChildren;
  let summary!: ReturnType<typeof useAttentionSummary>;
  function Harness() {
    summary = useAttentionSummary();
    tree = ConversationAttention({ account, onOpen: vi.fn(), onOpenRequest });
    return null;
  }
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  return { cache, onOpenRequest, text: () => collectText(tree), nodes: () => collectNodes(tree), summary: () => summary,
    async unmount() { await root.unmount(); cache.clear(); } };
}

describe("first-contact attention", () => {
  it("counts incoming requests with no established-message alerts and opens the exact request", async () => {
    loadRequests.mockResolvedValue({ approaches: [request], total: 7 });
    const view = await mounted();
    try {
      await vi.waitFor(() => expect(view.summary().readyCount).toBe(7));
      await vi.waitFor(() => expect(view.text()).toContain("A visitor"));
      expect(view.text()).not.toContain("You’re caught up");
      const open = view.nodes().find((node) => node.type === "button" && collectText(node).includes("review message request"));
      await act(() => open?.props.onClick?.());
      expect(view.onOpenRequest).toHaveBeenCalledWith(request.id);
      loadRequests.mockResolvedValue({ approaches: [], total: 0 });
      await act(async () => { await refreshContactQuery(view.cache, INSTRUMENT_APPROACHES_KEY); });
      await vi.waitFor(() => expect(view.summary().readyCount).toBe(0));
      await vi.waitFor(() => expect(view.text()).toContain("You’re caught up on requests and alerts"));
      expect(view.text()).not.toContain("A visitor");
    } finally { await view.unmount(); }
  });

  it("does not announce caught up before requests load or after their read fails", async () => {
    const pending = deferred<ApproachListResult>();
    loadRequests.mockReturnValue(pending.promise);
    const view = await mounted();
    try {
      await vi.waitFor(() => expect(loadRequests).toHaveBeenCalled());
      expect(view.text()).not.toContain("You’re caught up");
      loadRequests.mockRejectedValue(new Error("Requests unavailable"));
      await act(async () => { await refreshContactQuery(view.cache, INSTRUMENT_APPROACHES_KEY); });
      await vi.waitFor(() => expect(view.text()).toContain("Requests unavailable"));
      expect(view.text()).not.toContain("You’re caught up");
      pending.resolve({ approaches: [], total: 0 });
    } finally { await view.unmount(); }
  });
});
