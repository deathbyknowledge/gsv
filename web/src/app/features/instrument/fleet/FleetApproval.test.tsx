import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { FleetApproval } from "./FleetApproval";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("pending child approval controls", () => {
  it("restores the original child request on reload, approves it exactly, and rejects a stale run", async () => {
    vi.stubGlobal("document", {});
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const original = { pid: "child", runId: "child-run", requestId: "child-request", callId: "fetch", toolName: "net.fetch",
      syscall: "net.fetch", target: "gsv", args: { url: "https://example.com" }, createdAt: 1 };
    let pending: typeof original | null = original;
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
      if (call === "proc.history") return { data: { ok: true, pid: "child", format: 2, messages: [], records: [], messageCount: 0,
        historyRevision: 0, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false,
        activeRunId: pending?.runId ?? null, pendingHil: pending } };
      if (call === "proc.hil") {
        pending = null;
        return { data: { ok: true, pid: "child", requestId: "child-request", decision: "approve", resumed: true } };
      }
      throw new Error(`Unexpected request ${call}: ${JSON.stringify(args)}`);
    });
    async function mount(runId: string) {
      const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const root = createTestRoot("Child approval");
      let tree: ComponentChildren;
      function Harness() { tree = FleetApproval({ pid: "child", runId }); return null; }
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      return { text: () => collectText(tree), buttons: () => collectNodes(tree).filter((node) => node.type === "button"),
        close: async () => { await root.unmount(); cache.clear(); } };
    }
    let view = await mount("child-run");
    await vi.waitFor(() => expect(view.text()).toContain("net.fetch"));
    await view.close();
    view = await mount("child-run");
    try {
      await vi.waitFor(() => expect(view.buttons().find((button) => collectText(button) === "approve")?.props.disabled).toBe(false));
      await act(async () => { await view.buttons().find((button) => collectText(button) === "approve")?.props.onClick?.(); });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("proc.hil", { pid: "child", requestId: "child-request", decision: "approve" }));
      await vi.waitFor(() => expect(view.text()).toContain("Decision recorded"));
      expect(request.mock.calls.filter(([call]) => call === "proc.history").every(([, args]) => args?.includeMessages === false)).toBe(true);
    } finally { await view.close(); }
    pending = { ...original, requestId: "replacement-request", runId: "replacement-run" };
    view = await mount("child-run");
    try {
      await vi.waitFor(() => expect(view.text()).toContain("No approval is pending"));
      expect(view.buttons()).toHaveLength(0);
      expect(request.mock.calls.filter(([call]) => call === "proc.hil")).toHaveLength(1);
    } finally { await view.close(); }
  });
});
