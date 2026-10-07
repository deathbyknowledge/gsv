import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { GSVClient } from "@humansandmachines/gsv/client";
import { encodeBrowserViewPacket, type CloudInstance } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { BrowserViewer } from "./BrowserControl";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("live browser viewing", () => {
  it("watches without a handoff, binds input to the displayed image, and discards unsent input on close", async () => {
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser 1234abcd", state: "starting", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const push = (documentId: string, sequence: number) => source.enqueue(encodeBrowserViewPacket({ kind: "frame", documentId, sequence, capturedAt: Date.now(), tabId: 7, width: 1280, height: 800 }, new Uint8Array([1, 2, 3])));
    const inputResult = deferred<{ data: { accepted: true } }>();
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
      if (call === "sys.instance.get") return { data: { instance: { ...instance } } };
      if (call === "sys.browser.watch") {
        return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>({ start(c) {
          source = c;
          c.enqueue(encodeBrowserViewPacket({ kind: "state", activeTabId: 7, tabs: [{ id: 7, title: "Example", url: "https://example.com" }], pointer: { tabId: 7, x: 50, y: 100, actor: "ship", clickedAt: 1 } }));
          push("displayed-document", 1);
        }, cancel }) } };
      }
      if (call === "sys.browser.input") return inputResult.promise;
      throw new Error(`Unexpected request ${call}`);
    });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const root = createTestRoot("Live browser"), close = vi.fn();
    let tree: ComponentChildren;
    function Harness() { tree = BrowserViewer({ request: { instanceId: instance.instanceId }, onClose: close }); return null; }
    // SAFETY: These VNodes are selected by their intrinsic element, which defines these props.
    const image = () => collectNodes(tree).find(node => node.type === "img") as VNode<JSX.ImgHTMLAttributes<HTMLImageElement>> | undefined;
    // SAFETY: The textarea is the viewer's keyboard input; its intrinsic props supply this event handler.
    const keyboard = () => collectNodes(tree).find(node => node.type === "textarea") as VNode<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>>;
    const type = (value: string) => {
      // SAFETY: The handler reads only currentTarget.value and isComposing, both supplied here.
      const event = { currentTarget: { value }, isComposing: false } as JSX.TargetedInputEvent<HTMLTextAreaElement>;
      keyboard().props.onInput?.(event);
    };
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(collectText(tree)).toContain("Starting browser…"));
      expect(request.mock.calls.some(([call]) => call === "sys.browser.watch")).toBe(false);
      instance.state = "ready";
      await act(() => { cache.setQueryData(["cloud-instance", instance.instanceId], { instance: { ...instance } }); });
      await vi.waitFor(() => expect(image()).toBeDefined());
      const first = image()!;
      // SAFETY: The onLoad callback takes no event data; a real event satisfies its invocation contract.
      first.props.onLoad?.(new Event("load") as JSX.TargetedEvent<HTMLImageElement>);
      expect(collectNodes(tree).some(node => node.props["aria-label"] === "Ship cursor")).toBe(true);
      push("new-but-not-loaded", 2);
      await vi.waitFor(() => expect(image()?.props.src).not.toBe(first.props.src));
      await act(() => { type("hello"); type("unsent"); });
      await vi.waitFor(() => expect(request.mock.calls.filter(([call]) => call === "sys.browser.input")).toHaveLength(1));
      expect(request.mock.calls.find(([call]) => call === "sys.browser.input")?.[1]).toEqual({
        instanceId: instance.instanceId, tabId: 7, documentId: "displayed-document", handoffRequestId: undefined,
      });
      await act(async () => {
        await collectNodes(tree).find(node => node.type === "button" && node.props["aria-label"] === "Close browser view")?.props.onClick?.();
        inputResult.resolve({ data: { accepted: true } });
        await inputResult.promise;
      });
      expect(close).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([call]) => call === "sys.browser.input")).toHaveLength(1);
      expect(request.mock.calls.some(([call]) => call.startsWith("sys.browser.handoff.") || call === "sys.instance.stop")).toBe(false);
    } finally { await root.unmount(); cache.clear(); }
    expect(cancel).toHaveBeenCalledOnce();
  });
});
