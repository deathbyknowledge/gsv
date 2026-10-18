import { GSVClient } from "@humansandmachines/gsv/client";
import type { CloudInstance, SysTargetSummary } from "@humansandmachines/gsv/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentType } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { Fleet } from "../fleet/Fleet";
import { FleetDialog } from "../fleet/FleetDialog";
import { PromptLine } from "../shared/PromptLine";
import { ChatPanels } from "../zen/ChatPanels";
import { Zen } from "../zen/Zen";
import { BrowserControlProvider, useBrowserControl } from "./BrowserControl";
import { CloudBrowserActions } from "./CloudInstances";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openTarget(view: "chat" | "fleet" | "actions", kind: "linux" | "browser", state: "ready" | "starting") {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    location: new URL("https://space.example/chat"), matchMedia: () => ({ matches: true }),
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "hank", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation(() => () => {});
  const instance: CloudInstance = { instanceId: "instance", targetId: "cloud-target", startRequestId: "start", ownerUid: 1000,
    templateId: kind === "linux" ? "computer" : "browser", templateRevision: "1", kind, implements: ["shell.exec"],
    label: "Cloud target", state, revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
  const target: SysTargetSummary = { targetId: instance.targetId, label: instance.label, online: state === "ready", implements: instance.implements,
    platform: kind, ownerUid: 1000, ownerUsername: "hank", description: "", version: "test", lastSeenAt: 1,
    instance: { instanceId: instance.instanceId, state, expiresAt: instance.expiresAt } };
  const conversation = { id: "conversation", kind: "ship", ownerUid: 1000, title: null, handlerPid: "ship", latestSequence: 0, createdAt: 1, updatedAt: 1 };
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
    if (call === "sys.target.list") return { data: { targets: [target] } };
    if (call === "sys.instance.list") return { data: { instances: [instance], handoffs: [] } };
    if (call === "proc.list") return { data: { processes: [{ pid: "ship", uid: 1001, username: "ship", label: "Ship",
      personal: true, interactive: true, parentPid: null, state: "idle", activeRunId: null, queuedCount: 0, createdAt: 1, lastActiveAt: 1, cwd: "/home/ship" }] } };
    if (call === "account.list") return { data: { accounts: [] } };
    if (call === "sys.config.get") return { data: { entries: [] } };
    if (call === "conversation.forProcess") return { data: { conversation } };
    if (call === "conversation.history") return { data: { conversation, messages: [], hasMore: false } };
    if (call === "proc.observe" || call === "proc.unobserve") return { data: { ok: true, pid: "ship" } };
    if (call === "proc.history") return { data: { ok: true, pid: "ship", format: 2, records: [], messages: [], messageCount: 0,
      cursor: "epoch:1", hasMore: false, activeRunId: null, context: null, contextRevision: 0, historyRevision: 1, historyGeneration: 1, historyResetRevision: 0 } };
    throw new Error(`Unexpected request ${call}`);
  });
  const root = createTestRoot("Cloud target selection");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  let browser: ReturnType<typeof useBrowserControl>;
  const onFleet = vi.fn();
  function Harness() {
    browser = useBrowserControl();
    tree = view === "chat" ? Zen({ onFleet }) : view === "fleet"
      ? Fleet({ openRequest: null, onCommand: vi.fn(), onZen: vi.fn(), onActivity: vi.fn() }) : CloudBrowserActions({ targetId: target.targetId, allowed: true });
    return null;
  }
  const render = () => root.render(<GatewayProvider><SessionProvider createService={client => {
    const service = createSessionService(client);
    return { ...service, start: async () => {}, subscribe: () => () => {}, snapshot: () => ({ ...service.snapshot(),
      username: "hank", url: "wss://space.example/ws", server: { version: "test", release: "test", features: ["cloud-instances"] } }) };
  }}><TerminalProvider><QueryClientProvider client={cache}><BrowserControlProvider><Harness /></BrowserControlProvider></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
  const props = <P,>(component: ComponentType<P>): P => {
    const node = collectNodes(tree).find(entry => entry.type === component);
    if (!node) throw new Error(`Missing ${component.name}`);
    // SAFETY: The node was selected by the exact component whose props type P describes.
    return node.props as P;
  };
  await render();
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  await render();
  return { target, onFleet, props, nodes: () => collectNodes(tree), browser: () => browser,
    async close() { await root.unmount(); cache.clear(); } };
}

describe("cloud target selection", () => {
  it.each(["linux", "browser"] as const)("routes a ready %s target from Chat by its kind", async kind => {
    const view = await openTarget("chat", kind, "ready");
    try {
      const choice = view.nodes().find(node => node.type === "button" && collectText(node).includes("Cloud target"))!;
      expect(choice.props.disabled).toBe(false);
      await act(() => choice.props.onClick?.());
      expect(view.props(PromptLine).place.id).toBe(kind === "linux" ? view.target.targetId : "gsv");
      expect(view.browser().selection).toEqual(kind === "browser" ? { instanceId: "instance", requestId: undefined } : null);
      expect(view.onFleet).not.toHaveBeenCalled();
      await act(() => view.props(ChatPanels).onFleet(`target:${view.target.targetId}`));
      if (kind === "linux") expect(view.onFleet).toHaveBeenCalledWith(`target:${view.target.targetId}`);
      else expect(view.onFleet).not.toHaveBeenCalled();
      expect(view.browser().selection?.instanceId ?? null).toBe(kind === "browser" ? "instance" : null);
    } finally { await view.close(); }
  });

  it.each(["linux", "browser"] as const)("only offers the viewer while a %s target starts", async kind => {
    const view = await openTarget("chat", kind, "starting");
    try {
      const choice = view.nodes().find(node => node.type === "button" && collectText(node).includes("Cloud target"))!;
      expect(choice.props.disabled).toBe(kind === "linux");
      if (kind === "browser") {
        await act(() => choice.props.onClick?.());
        expect(view.browser().selection?.instanceId).toBe("instance");
      }
    } finally { await view.close(); }
  });

  it.each(["linux", "browser"] as const)("opens the correct Fleet inspector for a %s target", async kind => {
    const view = await openTarget("fleet", kind, "ready");
    try {
      const row = view.nodes().find(node => node.type === "tr" && collectText(node).includes("Cloud target"))!;
      await act(() => row.props.onClick?.());
      expect(view.props(FleetDialog).open).toBe(kind === "linux");
      expect(view.browser().selection?.instanceId ?? null).toBe(kind === "browser" ? "instance" : null);
    } finally { await view.close(); }
  });

  it.each(["linux", "browser"] as const)("only offers browser controls for a %s instance", async kind => {
    const view = await openTarget("actions", kind, "ready");
    try {
      await vi.waitFor(() => expect(view.nodes().some(node => node.type === "button" && collectText(node) === "open browser")).toBe(kind === "browser"));
    } finally { await view.close(); }
  });
});
