import { GSVClient } from "@humansandmachines/gsv/client";
import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import type { ComponentChildren, ComponentType } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import { collectNodes, createTestRoot } from "../../../testing/testHarness";
import { BrowserControlProvider } from "../browser/BrowserControl";
import { FilePreview } from "../shared/FilePreview";
import { PlaceTree } from "../shared/PlaceFiles";
import { FileReader } from "./FileReader";
import { Fleet, type FleetProps } from "./Fleet";
import { FleetDialog } from "./FleetDialog";
import type { FleetRow } from "../Instrument";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openFleet(reference: FleetRow) {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", {
    location: new URL("https://space.example/fleet"), matchMedia: () => ({ matches: true }),
    addEventListener: () => {}, removeEventListener: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: "wss://space.example/ws", username: "hank", connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "onSignal").mockImplementation(() => () => {});
  vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call) => {
    if (call === "sys.target.list") return { data: { targets: [] } };
    if (call === "proc.list") return { data: { processes: [] } };
    if (call === "account.list") return { data: { accounts: [] } };
    if (call === "fs.read") return { data: { ok: false, error: "no files in this test" } };
    throw new Error(`Unexpected request ${call}`);
  });
  const root = createTestRoot("Fleet file references");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  let openRequest: FleetProps["openRequest"] = null;
  const onZen = vi.fn();
  function Harness() {
    tree = Fleet({ openRequest, onCommand: vi.fn(), onZen, onActivity: vi.fn() });
    return null;
  }
  const render = () => root.render(<GatewayProvider><SessionProvider createService={(client) => {
    const service = createSessionService(client);
    return { ...service, start: async () => {}, subscribe: () => () => {}, snapshot: () => ({ ...service.snapshot(), username: "hank", url: "wss://space.example/ws" }) };
  }}><TerminalProvider><QueryClientProvider client={cache}><BrowserControlProvider><Harness /></BrowserControlProvider></QueryClientProvider></TerminalProvider></SessionProvider></GatewayProvider>);
  await render();
  await vi.waitFor(() => expect(cache.isFetching()).toBe(0));
  openRequest = { reference };
  await render();
  await render();
  const find = <P,>(component: ComponentType<P>): P | null => {
    const node = collectNodes(tree).find((entry) => entry.type === component);
    // SAFETY: The node was selected by the exact component whose props type P describes.
    return node ? node.props as P : null;
  };
  const nodes = () => collectNodes(tree);
  return { find, nodes, render, onZen, async close() { await root.unmount(); cache.clear(); } };
}

describe("files opened from Chat", () => {
  it("opens a linked file in the full reader, with the chat a step back", async () => {
    const view = await openFleet("file:gsv:/home/hank/lease/summary.md");
    try {
      expect(view.find(FileReader)?.file).toEqual({ target: "gsv", path: "/home/hank/lease/summary.md", name: "summary.md" });
      expect(view.find(FileReader)?.backLabel).toBe("← chat");
      expect(view.find(FleetDialog)?.open).toBe(false);
      expect(view.find(FilePreview)).toBeNull();
      expect(view.find(PlaceTree)).toBeNull();
      await act(() => view.find(FileReader)?.onClose());
      await view.render();
      expect(view.onZen).toHaveBeenCalledWith();
      expect(view.find(FileReader)).toBeNull();
    } finally { await view.close(); }
  });
});
