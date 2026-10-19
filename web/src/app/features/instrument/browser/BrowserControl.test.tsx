import { QueryClient, QueryClientProvider } from "@tanstack/preact-query";
import { GSVClient } from "@humansandmachines/gsv/client";
import { encodeBrowserViewPacket, type BrowserHandoff, type CloudInstance } from "@humansandmachines/gsv/protocol";
import type { ComponentChildren, JSX, VNode } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { collectNodes, collectText, createTestRoot, deferred } from "../../../testing/testHarness";
import { BrowserViewer } from "./BrowserControl";

beforeEach(() => {
  const location = new URL("https://space.example/?browserInstance=instance&browserHandoff=linked-login");
  vi.stubGlobal("window", { location, history: { state: null, replaceState: vi.fn((_state, _unused, url: URL) => { location.href = url.href; }) } });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openLinkedViewer(initialState: "pending" | "active" | undefined, initialId = "new-login", options: { manualFrames?: boolean; finish?: () => Promise<BrowserHandoff> } = {}) {
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
    templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
  const handoff: BrowserHandoff = { instanceId: instance.instanceId, requestId: "linked-login", tabId: 1, site: "https://example.com", purpose: "Sign in", state: "active", revision: 1, createdAt: 1, expiresAt: instance.expiresAt };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let watches = 0;
  const frame = (tabId: number, sequence: number) => source.enqueue(encodeBrowserViewPacket({ kind: "frame", tabId,
    documentId: `document-${tabId}`, sequence, capturedAt: Date.now(), width: 1280, height: 800 }, new Uint8Array([1])));
  const push = (state: "pending" | "active" | undefined, requestId = "new-login") => source.enqueue(encodeBrowserViewPacket({
    kind: "state", activeTabId: 1, tabs: [{ id: 1, title: "Login", url: handoff.site }, { id: 2, title: "Other tab", url: "https://other.example" }], handoff: state ? { ...handoff, requestId, state } : undefined,
  }));
  const inputResult = deferred<{ data: { accepted: true } }>();
  const request = vi.spyOn(GSVClient.prototype, "request").mockImplementation(async call => {
    if (call === "sys.instance.get") return { data: { instance } };
    if (call === "sys.browser.watch") return { data: { watchId: "watch", version: 1 }, body: { stream: new ReadableStream<Uint8Array>({ start(controller) {
      source = controller; watches++; push(initialState, initialId);
      if (!options.manualFrames || watches === 1) frame(1, 1);
    } }) } };
    if (call === "sys.browser.input") return inputResult.promise;
    if (call === "sys.browser.handoff.open") return { data: { handoff } };
    if (call === "sys.browser.handoff.finish") return { data: { handoff: options.finish ? await options.finish() : { ...handoff, state: "completed" } } };
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
  return { request, handoff, inputResult, push, frame, nodes, text: () => collectText(tree),
    disconnect() { source.error(new Error("Viewer connection lost")); },
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
  it.each(["disconnect", "hidden"] as const)("requires a new displayed image after the view is %s even when the document ID stays unchanged", async reason => {
    const viewer = await openLinkedViewer("active", "linked-login", { manualFrames: true });
    // SAFETY: This selects the intrinsic viewer image and uses its image event props.
    const image = () => viewer.nodes().find(node => node.type === "img") as VNode<JSX.ImgHTMLAttributes<HTMLImageElement>>;
    // SAFETY: The image load callback reads no event data.
    const loaded = new Event("load") as JSX.TargetedEvent<HTMLImageElement>;
    const inputs = () => viewer.request.mock.calls.filter(([call]) => call === "sys.browser.input");
    try {
      const old = image();
      await act(() => { viewer.type("first"); viewer.type("unsent from old view"); });
      await vi.waitFor(() => expect(inputs()).toHaveLength(1));
      await act(() => {
        if (reason === "disconnect") viewer.disconnect();
        else {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      await vi.waitFor(() => expect(viewer.nodes().find(node => node.type === "textarea")?.props.disabled).toBe(true));
      await act(async () => {
        viewer.inputResult.resolve({ data: { accepted: true } }); await viewer.inputResult.promise;
        old.props.onLoad?.(loaded); viewer.type("stale view");
        if (reason === "hidden") {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.watch")).toHaveLength(2));
      await act(() => { viewer.type("before a fresh frame"); viewer.frame(1, 2); });
      await vi.waitFor(() => expect(image().props.src).not.toBe(old.props.src));
      await act(() => { viewer.type("before the fresh frame loads"); });
      expect(inputs()).toHaveLength(1);
      await act(() => { image().props.onLoad?.(loaded); viewer.type("fresh view"); });
      await vi.waitFor(() => expect(inputs()).toHaveLength(2));
      expect(inputs()[0][1]).toEqual(inputs()[1][1]);
    } finally { await viewer.close(); }
  });

  it("fences immediate, queued and late-image input until the newly selected view has loaded", async () => {
    const viewer = await openLinkedViewer("active", "linked-login", { manualFrames: true });
    // SAFETY: This selects the intrinsic viewer image and uses its image event props.
    const image = () => viewer.nodes().find(node => node.type === "img") as VNode<JSX.ImgHTMLAttributes<HTMLImageElement>>;
    // SAFETY: The image load callback reads no event data.
    const loaded = new Event("load") as JSX.TargetedEvent<HTMLImageElement>;
    const inputs = () => viewer.request.mock.calls.filter(([call]) => call === "sys.browser.input");
    try {
      const original = image();
      await act(() => { viewer.type("first"); viewer.type("queued for first tab"); });
      await vi.waitFor(() => expect(inputs()).toHaveLength(1));
      await act(() => {
        viewer.nodes().find(node => node.type === "button" && collectText(node) === "Other tab")!.props.onClick?.();
        viewer.type("immediately after switching");
      });
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.watch")).toHaveLength(2));
      await act(async () => {
        original.props.onLoad?.(loaded);
        viewer.type("after a late old image");
        viewer.inputResult.resolve({ data: { accepted: true } });
        await viewer.inputResult.promise;
      });
      expect(inputs()).toHaveLength(1);
      await act(() => { viewer.frame(2, 2); });
      await vi.waitFor(() => expect(image().props.src).not.toBe(original.props.src));
      await act(() => { viewer.type("new image has not loaded yet"); });
      expect(inputs()).toHaveLength(1);
      const second = image();
      await act(() => { second.props.onLoad?.(loaded); viewer.type("second tab"); });
      await vi.waitFor(() => expect(inputs()).toHaveLength(2));
      expect(inputs()[1][1]).toMatchObject({ tabId: 2, documentId: "document-2" });
      await act(() => {
        viewer.nodes().find(node => node.type === "button" && collectText(node) === "follow Ship")!.props.onClick?.();
        viewer.type("immediately after following");
      });
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.watch")).toHaveLength(3));
      await act(() => { original.props.onLoad?.(loaded); viewer.type("stale original follow image"); });
      expect(inputs()).toHaveLength(2);
      await act(() => { viewer.frame(1, 3); });
      await vi.waitFor(() => expect(image().props.src).not.toBe(second.props.src));
      await act(() => { image().props.onLoad?.(loaded); viewer.type("fresh follow image"); });
      await vi.waitFor(() => expect(inputs()).toHaveLength(3));
      expect(inputs()[2][1]).toMatchObject({ tabId: 1, documentId: "document-1" });
    } finally { await viewer.close(); }
  });

  it.each(["pending", "active", undefined] as const)("rejects an old action link when the current handoff is %s", async state => {
    const viewer = await openLinkedViewer(state);
    try {
      await vi.waitFor(() => expect(viewer.text()).toContain("This browser request has expired or ended"));
      expect(viewer.nodes().some(node => node.type === "button" && collectText(node) === "I’m done — resume Ship")).toBe(false);
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
      const finish = viewer.nodes().find(node => node.type === "button" && collectText(node) === "I’m done — resume Ship");
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

  it.each(["stream", "response"] as const)("returns a completed handoff to live viewing when the %s arrives first", async first => {
    const completion = deferred<BrowserHandoff>();
    const viewer = await openLinkedViewer("active", "linked-login", { finish: () => completion.promise });
    try {
      const finish = viewer.nodes().find(node => node.type === "button" && collectText(node) === "I’m done — resume Ship");
      await act(() => { finish!.props.onClick?.(); });
      await vi.waitFor(() => expect(viewer.request.mock.calls.some(([call]) => call === "sys.browser.handoff.finish")).toBe(true));
      if (first === "stream") {
        await act(() => { viewer.push(undefined); });
        await vi.waitFor(() => expect(viewer.text()).toContain("Saving before Ship resumes"));
        expect(viewer.text()).not.toContain("expired or ended");
        expect(viewer.nodes().find(node => node.type === "textarea")?.props.disabled).toBe(true);
      }
      await act(async () => { completion.resolve({ ...viewer.handoff, state: "completed" }); await completion.promise; });
      await vi.waitFor(() => expect(viewer.text()).toContain("You’re done. Ship can continue."));
      expect(viewer.nodes().some(node => node.type === "button" && collectText(node) === "I’m done — resume Ship")).toBe(false);
      if (first === "response") await act(() => { viewer.push(undefined); });
      await vi.waitFor(() => expect(viewer.nodes().find(node => node.type === "textarea")?.props.disabled).toBe(false));
      expect(viewer.text()).not.toContain("expired or ended");
      expect(new URL(window.location.href).searchParams.has("browserHandoff")).toBe(false);
      expect(new URL(window.location.href).searchParams.get("browserInstance")).toBe("instance");
      await act(() => { viewer.type("ordinary live input"); });
      await vi.waitFor(() => expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.input")).toHaveLength(1));
      expect(viewer.request.mock.calls.find(([call]) => call === "sys.browser.input")?.[1]).toMatchObject({ handoffRequestId: undefined });
      expect(viewer.request.mock.calls.filter(([call]) => call === "sys.browser.watch")).toHaveLength(1);
    } finally { await viewer.close(); }
  });

  it.each(["cancelled", "expired"] as const)("keeps an action link bound when completion returns %s", async state => {
    const completion = deferred<BrowserHandoff>();
    const viewer = await openLinkedViewer("active", "linked-login", { finish: () => completion.promise });
    try {
      const finish = viewer.nodes().find(node => node.type === "button" && collectText(node) === "I’m done — resume Ship");
      await act(() => { finish!.props.onClick?.(); });
      await vi.waitFor(() => expect(viewer.request.mock.calls.some(([call]) => call === "sys.browser.handoff.finish")).toBe(true));
      await act(async () => { viewer.push(undefined); completion.resolve({ ...viewer.handoff, state }); await completion.promise; });
      await vi.waitFor(() => expect(viewer.text()).toContain("This browser request has expired or ended"));
      await act(() => { viewer.push("pending", "another-request"); });
      await vi.waitFor(() => expect(viewer.nodes().find(node => node.type === "textarea")?.props.disabled).toBe(true));
      expect(viewer.text()).not.toContain("You’re done");
      expect(new URL(window.location.href).searchParams.get("browserHandoff")).toBe("linked-login");
      expect(viewer.request.mock.calls.some(([call]) => call === "sys.browser.handoff.open")).toBe(false);
    } finally { await viewer.close(); }
  });

  it("does not rewrite the action link after its viewer closes during completion", async () => {
    const completion = deferred<BrowserHandoff>();
    const viewer = await openLinkedViewer("active", "linked-login", { finish: () => completion.promise });
    const finish = viewer.nodes().find(node => node.type === "button" && collectText(node) === "I’m done — resume Ship");
    await act(() => { finish!.props.onClick?.(); });
    await vi.waitFor(() => expect(viewer.request.mock.calls.some(([call]) => call === "sys.browser.handoff.finish")).toBe(true));
    await viewer.close();
    await act(async () => { completion.resolve({ ...viewer.handoff, state: "completed" }); await completion.promise; });
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });

  it("keeps completion available after a save failure and clears the warning after retry", async () => {
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
    vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
    const instance: CloudInstance = { instanceId: "instance", targetId: "1234abcd", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser", state: "ready", revision: 1, createdAt: 1, expiresAt: Date.now() + 60000 };
    const handoff: BrowserHandoff = { instanceId: instance.instanceId, requestId: "login", tabId: 1, site: "https://example.com", purpose: "Sign in", state: "active", revision: 1, createdAt: 1, expiresAt: instance.expiresAt };
    const finish = vi.fn().mockRejectedValueOnce(new Error("Save failed; retry finishing")).mockResolvedValueOnce({ data: { handoff: { ...handoff, state: "completed" } } });
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
    const button = () => collectNodes(tree).find(node => node.type === "button" && collectText(node) === "I’m done — resume Ship");
    try {
      await root.render(<GatewayProvider><QueryClientProvider client={cache}><Harness /></QueryClientProvider></GatewayProvider>);
      await vi.waitFor(() => expect(button()).toBeDefined());
      await act(async () => { button()!.props.onClick?.(); });
      await vi.waitFor(() => expect(collectText(tree)).toContain("Save failed; retry finishing"));
      expect(button()!.props.disabled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await act(async () => { button()!.props.onClick?.(); });
      await vi.waitFor(() => expect(collectText(tree)).not.toContain("Save failed; retry finishing"));
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
