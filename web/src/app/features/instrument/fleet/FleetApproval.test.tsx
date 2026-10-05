import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GSVClient } from "@humansandmachines/gsv/client";
import type { ProcHilArgs } from "@humansandmachines/gsv/protocol";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { FleetApproval } from "./FleetApproval";
import { ApprovalCard, type ApprovalCardProps } from "../shared/ApprovalCard";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("pending child approval controls", () => {
  it.each([false, true])("restores the original child request on reload, approves it exactly, and rejects a stale run (remember: %s)", async (remember) => {
    vi.stubGlobal("document", {});
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const original = { pid: "child", runId: "child-run", requestId: "child-request", callId: "fetch", toolName: "Shell",
      syscall: "shell.exec", target: "laptop", args: { input: "curl https://example.com", target: "laptop" }, purpose: "fetch the example page", createdAt: 1 };
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
      function Harness() { tree = FleetApproval({ pid: "child", runId, who: "crew", label: "Read the example page" }); return null; }
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      const card = () => {
        // SAFETY: The VNode is selected by the exact component whose props type is ApprovalCardProps.
        const node = collectNodes(tree).find((node) => node.type === ApprovalCard) as VNode<ApprovalCardProps> | undefined;
        return node ? ApprovalCard(node.props) : null;
      };
      return { text: () => collectText([tree, card()]), buttons: () => collectNodes(card()).filter((node) => node.type === "button"),
        close: async () => { await root.unmount(); cache.clear(); } };
    }
    let view = await mount("child-run");
    await vi.waitFor(() => expect(view.text()).toContain("https://example.com"));
    expect(view.text()).toContain("Fetch the example page");
    expect(view.text()).toContain("Read the example page");
    expect(view.text()).not.toContain("The process is held");
    await view.close();
    view = await mount("child-run");
    try {
      const button = remember ? "always allow" : "run it";
      await vi.waitFor(() => expect(view.buttons().find((node) => collectText(node).trim() === button)?.props.disabled).toBe(false));
      await act(async () => { await view.buttons().find((node) => collectText(node).trim() === button)?.props.onClick?.(); });
      const expected: ProcHilArgs = { pid: "child", requestId: "child-request", decision: "approve" };
      if (remember) expected.remember = true;
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("proc.hil", expected));
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
