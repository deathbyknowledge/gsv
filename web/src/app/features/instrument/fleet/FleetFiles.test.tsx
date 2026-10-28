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
    throw new Error(`Unexpected request ${call}`);
  });
  const root = createTestRoot("Fleet file references");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let tree: ComponentChildren;
  let openRequest: FleetProps["openRequest"] = null;
  function Harness() {
    tree = Fleet({ openRequest, onCommand: vi.fn(), onZen: vi.fn(), onActivity: vi.fn() });
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
  return { find, render, async close() { await root.unmount(); cache.clear(); } };
}

describe("paths opened from Ship's text", () => {
  it("opens a linked file in the preview", async () => {
    const view = await openFleet("file:gsv:/home/hank/lease/summary.md");
    try {
      expect(view.find(FleetDialog)?.open).toBe(true);
      expect(view.find(FilePreview)?.file).toEqual({ target: "gsv", path: "/home/hank/lease/summary.md", name: "summary.md" });
      expect(view.find(PlaceTree)).toBeNull();
    } finally { await view.close(); }
  });

  it("opens a linked folder in the cloud home's tree at that folder", async () => {
    const view = await openFleet("dir:gsv:~/lease");
    try {
      expect(view.find(FilePreview)).toBeNull();
      expect(view.find(PlaceTree)?.place.id).toBe("gsv");
      expect(view.find(PlaceTree)?.initialPath).toBe("~/lease");
    } finally { await view.close(); }
  });

  it("shows a linked path without a trailing slash as a folder when it reads as one", async () => {
    const view = await openFleet("file:gsv:/home/hank/lease");
    try {
      const onFolder = view.find(FilePreview)?.onFolder;
      expect(onFolder).toBeTypeOf("function");
      await act(() => onFolder?.("/home/hank/lease"));
      await view.render();
      expect(view.find(FilePreview)).toBeNull();
      expect(view.find(PlaceTree)?.initialPath).toBe("/home/hank/lease");
    } finally { await view.close(); }
  });
});
