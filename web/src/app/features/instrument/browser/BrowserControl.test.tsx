import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { GSVClient } from "@humansandmachines/gsv/client";
import { encodeBrowserViewPacket, type BrowserHandoff, type CloudInstance } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { BrowserViewer } from "./BrowserControl";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openLinkedViewer(initialState: "pending" | "active" | undefined, initialId = "new-login") {
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
    templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
  const handoff: BrowserHandoff = { instanceId: instance.instanceId, requestId: "linked-login", tabId: 1, site: "https://example.com", purpose: "Sign in", state: "active", revision: 1, createdAt: 1, expiresAt: instance.expiresAt };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const push = (state: "pending" | "active" | undefined, requestId = "new-login") => source.enqueue(encodeBrowserViewPacket({
    kind: "state", activeTabId: 1, tabs: [{ id: 1, title: "Login", url: handoff.site }], handoff: state ? { ...handoff, requestId, state } : undefined,
  }));
  const inputResult = deferred<{ data: { accepted: true } }>();
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
    if (call === "sys.instance.get") return { data: { instance } };
    if (call === "sys.browser.watch") return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>({ start(controller) {
      source = controller; push(initialState, initialId);
      controller.enqueue(encodeBrowserViewPacket({ kind: "frame", tabId: 1, documentId: "document", sequence: 1, capturedAt: Date.now(), width: 1280, height: 800 }, new Uint8Array([1])));
    } }) } };
    if (call === "sys.browser.input") return inputResult.promise;
    if (call === "sys.browser.handoff.open" || call === "sys.browser.handoff.finish") return { data: { handoff } };
    throw new Error(`Unexpected request ${call}`);
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createTestRoot("Linked browser request");
  let tree: ComponentChildren;
  function Harness() { tree = BrowserViewer({ request: { instanceId: instance.instanceId, requestId: "linked-login" }, onClose: vi.fn() }); return null; }
  const nodes = () => collectNodes(tree);
  await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
  await vi.waitFor(() => expect(nodes().find(node => node.type === "img")).toBeDefined());
  // SAFETY: This intrinsic image node has the viewer's image props.
  const image = nodes().find(node => node.type === "img") as VNode<JSX.ImgHTMLAttributes<HTMLImageElement>>;
  // SAFETY: The image onLoad handler reads no event data.
  const loaded = new Event("load") as JSX.TargetedEvent<HTMLImageElement>;
  await act(() => { image.props.onLoad?.(loaded); });
  return { request, inputResult, push, nodes, text: () => collectText(tree),
    type(value: string) {
      // SAFETY: The intrinsic textarea handler reads only currentTarget.value and isComposing.
      const keyboard = nodes().find(node => node.type === "textarea") as VNode<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>>;
      // SAFETY: The handler reads only currentTarget.value and isComposing.
      keyboard.props.onInput?.({ currentTarget: { value }, isComposing: false } as JSX.TargetedInputEvent<HTMLTextAreaElement>);
    },
    async close() { inputResult.resolve({ data: { accepted: true } }); await root.unmount(); cache.clear(); },
  };
}

describe("live browser viewing", () => {
  it.each(["pending", "active", undefined] as const)("rejects an old action link when the current handoff is %s", async state => {
    const viewer = await openLinkedViewer(state);
    try {
      await vi.waitFor(() => expect(viewer.text()).toContain("This browser request has expired or ended"));
      expect(viewer.nodes().some(node => node.type === "button" && collectText(node) === "continue")).toBe(false);
      await act(() => { viewer.type("private input"); });
      expect(viewer.request.mock.calls.some(([call]) => call.startsWith("sys.browser.handoff.") || call === "sys.browser.input")).toBe(false);
    } finally { await viewer.close(); }
  });

  it("opens only the linked request and drops queued input and completion when that request changes", async () => {
    const viewer = await openLinkedViewer("pending", "linked-login");
    try {
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.handoff.open")).toHaveLength(1));
      expect(viewer.request.mock.calls.find(([call]) => call === "sys.browser.handoff.open")?.[1]).toEqual({ instanceId: "instance", requestId: "linked-login" });
      await act(() => { viewer.push("active", "linked-login"); });
      await vi.waitFor(() => expect(viewer.nodes().find(node => node.type === "textarea")?.props.disabled).toBe(false));
      await act(() => { viewer.type("first"); viewer.type("unsent"); });
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.input")).toHaveLength(1));
      const finish = viewer.nodes().find(node => node.type === "button" && collectText(node) === "continue");
      await act(() => { finish!.props.onClick?.(); });
      await act(() => { viewer.push("pending"); });
      await vi.waitFor(() => expect(viewer.text()).toContain("This browser request has expired or ended"));
      await act(async () => { viewer.inputResult.resolve({ data: { accepted: true } }); await viewer.inputResult.promise; });
      expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.input")).toHaveLength(1);
      expect(viewer.request.mock.calls.find(([call]) => call === "sys.browser.input")?.[1]).toMatchObject({ handoffRequestId: "linked-login" });
      expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.handoff.open")).toHaveLength(1);
      expect(viewer.request.mock.calls.some(([call]) => call === "sys.browser.handoff.finish")).toBe(false);
    } finally { await viewer.close(); }
  });

  it("keeps Continue available after a save failure and clears the warning after retry", async () => {
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
    const handoff: BrowserHandoff = { instanceId: instance.instanceId, requestId: "login", tabId: 1, site: "https://example.com", purpose: "Sign in", state: "active", revision: 1, createdAt: 1, expiresAt: instance.expiresAt };
    const finish = vi.fn().mockRejectedValueOnce(new Error("Save failed; retry Continue")).mockResolvedValueOnce({ data: { handoff: { ...handoff, state: "completed" } } });
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
      if (call === "sys.instance.get") return { data: { instance } };
      if (call === "sys.browser.watch") return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encodeBrowserViewPacket({ kind: "state", activeTabId: 1, tabs: [{ id: 1, title: "Login", url: handoff.site }], handoff }));
        controller.enqueue(encodeBrowserViewPacket({ kind: "frame", tabId: 1, documentId: "document", sequence: 1, capturedAt: Date.now(), width: 1280, height: 800 }, new Uint8Array([1])));
      } }) } };
      if (call === "sys.browser.handoff.finish") return finish();
      throw new Error(`Unexpected request ${call}`);
    });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const root = createTestRoot("Retry handoff"), close = vi.fn();
    let tree: ComponentChildren;
    function Harness() { tree = BrowserViewer({ request: { instanceId: instance.instanceId, requestId: handoff.requestId }, onClose: close }); return null; }
    const button = () => collectNodes(tree).find(node => node.type === "button" && collectText(node) === "continue");
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(button()).toBeDefined());
      await act(async () => { button()!.props.onClick?.(); });
      await vi.waitFor(() => expect(collectText(tree)).toContain("Save failed; retry Continue"));
      expect(button()!.props.disabled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await act(async () => { button()!.props.onClick?.(); });
      await vi.waitFor(() => expect(collectText(tree)).not.toContain("Save failed; retry Continue"));
      expect(finish).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([call]) => call === "sys.browser.handoff.finish").map(([, args]) => args)).toEqual([
        { instanceId: "instance", requestId: "login" }, { instanceId: "instance", requestId: "login" },
      ]);
      expect(close).not.toHaveBeenCalled();
    } finally { await root.unmount(); cache.clear(); }
  });

  it("shows partial saves without treating them as a full failure or forcing shutdown", async () => {
    vi.stubGlobal("document", new EventTarget());
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000,
      profileId: "profile", persistence: { saveStatus: "partial", savedAt: 1, issues: [{ origin: "https://unsupported.example", reason: "unsupported", message: "Unsupported storage" }] } };
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
      if (call === "sys.instance.get") return { data: { instance } };
      if (call === "sys.browser.watch") return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>() } };
      if (call === "sys.instance.stop") return { data: { instance: { ...instance, state: "stopping" } } };
      throw new Error(`Unexpected request ${call}`);
    });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const root = createTestRoot("Partial save"), close = vi.fn();
    let tree: ComponentChildren;
    function Harness() { tree = BrowserViewer({ request: { instanceId: instance.instanceId }, onClose: close }); return null; }
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(collectText(tree)).toContain("Saved with exceptions"));
      expect(collectText(tree)).toContain("unsupported.example");
      expect(collectText(tree)).toContain("Other sites are saved");
      expect(collectText(tree)).not.toContain("stop without saving");
      const stop = collectNodes(tree).find(node => node.type === "button" && collectText(node) === "stop browser");
      await act(async () => { stop!.props.onClick?.(); });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(request.mock.calls.find(([call]) => call === "sys.instance.stop")?.[1]).toEqual({ instanceId: "instance", force: undefined });
    } finally { await root.unmount(); cache.clear(); }
  });
  it("keeps a browser open after a failed stop, retries saving, and requires an explicit force action", async () => {
    vi.stubGlobal("document", new EventTarget());
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
    const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async (call, args) => {
      if (call === "sys.instance.get") return { data: { instance: { ...instance } } };
      if (call === "sys.browser.watch") return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>() } };
      if (call === "sys.browser.profile.save") return { data: { profile: null } };
      if (call === "sys.instance.stop") {
        if (args && "force" in args && args.force) return { data: { instance: { ...instance, state: "stopping" } } };
        instance.persistence = { saveStatus: "failed", error: "Browser data could not be saved", savedAt: 1 };
        throw new Error("The browser is still running");
      }
      throw new Error(`Unexpected request ${call}`);
    });
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const root = createTestRoot("Save failure"), close = vi.fn();
    let tree: ComponentChildren;
    function Harness() { tree = BrowserViewer({ request: { instanceId: instance.instanceId }, onClose: close }); return null; }
    const click = async (label: string) => {
      const button = collectNodes(tree).find(node => node.type === "button" && collectText(node) === label);
      expect(button).toBeDefined();
      await act(async () => { button!.props.onClick?.(); });
    };
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(request.mock.calls.some(([call]) => call === "sys.browser.watch")).toBe(true));
      await click("stop browser");
      await vi.waitFor(() => expect(collectText(tree)).toContain("retry save"));
      expect(close).not.toHaveBeenCalled();
      await click("retry save");
      await vi.waitFor(() => expect(request.mock.calls.some(([call]) => call === "sys.browser.profile.save")).toBe(true));
      await click("stop without saving");
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(request.mock.calls.filter(([call]) => call === "sys.instance.stop").map(([, args]) => args)).toEqual([
        { instanceId: "instance", force: undefined }, { instanceId: "instance", force: true },
      ]);
    } finally { await root.unmount(); cache.clear(); }
  });
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
