import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { browserFrame, sendBrowserInput } from "../../../services/instances/browserControl";
import type { BrowserHumanInput, SysBrowserFrameResult } from "@humansandmachines/gsv/protocol";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import "./browser.css";

export const INSTANCE_QUERY_KEY = ["cloud-instances"];
type BrowserSelection = { instanceId: string; requestId?: string };
type BrowserControlContext = { available: boolean; selection: BrowserSelection | null; open: (request: BrowserSelection) => void; close: () => void };
const Context = createContext<BrowserControlContext>({ available: false, selection: null, open: () => {}, close: () => {} });
export function useBrowserControl() { return useContext(Context); }

export function BrowserControlProvider({ children }: { children: ComponentChildren }) {
  const { snapshot } = useSession();
  const available = snapshot.server?.features?.includes("cloud-instances") ?? false;
  const [selection, setSelection] = useState<BrowserSelection | null>(() => {
    const query = new URLSearchParams(window.location.search);
    const instanceId = query.get("browserInstance"), requestId = query.get("browserHandoff");
    return instanceId ? { instanceId, requestId: requestId ?? undefined } : null;
  });
  const close = () => {
    setSelection(null);
    const url = new URL(window.location.href); url.searchParams.delete("browserInstance"); url.searchParams.delete("browserHandoff");
    window.history.replaceState(window.history.state, "", url);
  };
  return <Context.Provider value={{ available, selection, close, open: request => setSelection({ instanceId: request.instanceId, requestId: request.requestId }) }}>
    {children}
  </Context.Provider>;
}

export function BrowserControlOverlay() {
  const { available, selection, close } = useBrowserControl();
  return available && selection ? <BrowserViewer key={`${selection.instanceId}/${selection.requestId}`} request={selection} onClose={close} /> : null;
}

export function useCloudInstances() {
  const { client, connected } = useGateway();
  const { available } = useBrowserControl();
  const queryClient = useQueryClient();
  const result = useQuery({ queryKey: INSTANCE_QUERY_KEY, queryFn: () => client.sys.instance.list({}), enabled: connected && available, refetchInterval: 2500 });
  const revision = result.data?.instances.map(value => `${value.instanceId}:${value.revision}`).join(",");
  useEffect(() => { if (revision !== undefined) void queryClient.invalidateQueries({ queryKey: INSTRUMENT_TARGETS_KEY }); }, [revision, queryClient]);
  return result;
}

export function BrowserRequests() {
  const { open, available } = useBrowserControl();
  const query = useCloudInstances();
  if (!available || !query.data?.handoffs.length) return null;
  return <section class="browser-requests" aria-label="Browser requests">
    {query.data.handoffs.map(request => <div class="browser-request" key={`${request.instanceId}/${request.requestId}`}>
      <div><strong>{request.purpose}</strong><span>{request.site} · {Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 60000))} minutes remaining</span></div>
      <button type="button" class="fleet-text-action is-primary" disabled={!request.site} onClick={() => open(request)}>{request.site ? "open browser" : "preparing browser…"}</button>
    </div>)}
  </section>;
}

export function BrowserViewer({ request, onClose }: { request: BrowserSelection; onClose: () => void }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const instanceQuery = useQuery({ queryKey: ["cloud-instance", request.instanceId], queryFn: () => client.sys.instance.get({ instanceId: request.instanceId }), enabled: connected, refetchInterval: 2500 });
  const instance = instanceQuery.data?.instance;
  const ready = instance?.state === "ready";
  const dialog = useRef<HTMLDialogElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<{ source: string; data: SysBrowserFrameResult } | null>(null);
  const displayed = useRef<SysBrowserFrameResult | null>(null);
  const [selectedTab, setSelectedTab] = useState<number>();
  const [error, setError] = useState("");
  const [frameError, setFrameError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const inputEpoch = useRef(0);
  const live = useRef(false);
  useLayoutEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    live.current = connected && ready;
    return () => { live.current = false; inputEpoch.current++; };
  }, [connected, ready, request.instanceId]);
  useEffect(() => {
    if (!connected || !ready) return;
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, url: string | undefined;
    const frame = async () => {
      try {
        const result = await browserFrame(client, { instanceId: request.instanceId, tabId: selectedTab }, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (result.data.handoff?.state === "pending" && result.data.handoff.site) {
          await client.sys.browser.handoff.open({ instanceId: request.instanceId, requestId: result.data.handoff.requestId });
          if (lifetime.signal.aborted) return;
        }
        const previous = url;
        url = URL.createObjectURL(result.image);
        setView({ source: url, data: result.data });
        setFrameError("");
        if (previous) URL.revokeObjectURL(previous);
      } catch (cause) { if (!lifetime.signal.aborted) setFrameError(String(cause)); }
      finally { if (!lifetime.signal.aborted) timer = setTimeout(() => void frame(), 250); }
    };
    void frame();
    return () => { lifetime.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [client, connected, ready, request.instanceId, selectedTab]);

  const input = (value: BrowserHumanInput) => {
    const shown = displayed.current;
    if (!live.current || busy || !shown || (shown.handoff && shown.handoff.state !== "active")) return;
    if (value.kind === "click") setSelectedTab(shown.tabId);
    const epoch = inputEpoch.current;
    const args = { instanceId: request.instanceId, tabId: shown.tabId, documentId: shown.documentId, handoffRequestId: shown.handoff?.requestId };
    inputQueue.current = inputQueue.current.then(async () => {
      if (!live.current || inputEpoch.current !== epoch) return;
      await sendBrowserInput(client, args, value);
      setError("");
    }).catch(cause => { inputEpoch.current++; setError(`Input could not be confirmed. ${String(cause)}`); });
  };
  const close = () => { live.current = false; inputEpoch.current++; onClose(); };
  const finish = async () => {
    const handoff = view?.data.handoff;
    if (!handoff || busy) return;
    setBusy(true);
    try {
      await inputQueue.current;
      inputEpoch.current++;
      await client.sys.browser.handoff.finish({ instanceId: request.instanceId, requestId: handoff.requestId });
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY });
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true); live.current = false; inputEpoch.current++;
    try {
      await client.sys.instance.stop({ instanceId: request.instanceId });
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY });
      onClose();
    } catch (cause) { setError(String(cause)); setBusy(false); live.current = connected; }
  };
  const point = (event: MouseEvent | WheelEvent) => {
    const bounds = image.current!.getBoundingClientRect();
    const width = displayed.current?.width ?? 1280, height = displayed.current?.height ?? 800;
    return { x: Math.max(0, Math.min(width, (event.clientX - bounds.left) * width / bounds.width)), y: Math.max(0, Math.min(height, (event.clientY - bounds.top) * height / bounds.height)) };
  };
  const data = view?.data;
  const tab = data?.tabs.find(tab => tab.id === data.tabId);
  const pointer = data?.pointer?.tabId === data?.tabId ? data?.pointer : undefined;
  return <dialog ref={dialog} class={`browser-viewer${expanded ? " is-expanded" : ""}`} aria-label="Live cloud browser" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <header class="browser-chrome">
      <div class="browser-tabs" role="tablist" aria-label="Browser tabs">
        {data?.tabs.map((item, index) => <button type="button" role="tab" aria-selected={item.id === data.tabId} tabIndex={item.id === data.tabId ? 0 : -1} key={item.id}
          onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % data.tabs.length : event.key === "ArrowLeft" ? (index + data.tabs.length - 1) % data.tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? data.tabs.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setSelectedTab(data.tabs[next]!.id);
            const button = event.currentTarget.parentElement?.children[next];
            if (button instanceof HTMLButtonElement) button.focus();
          }}
          title={item.url} onClick={() => setSelectedTab(item.id)}>{item.url === "about:blank" ? "New tab" : item.title || item.url}</button>)}
        {!data && <span class="browser-tab-loading">{instance?.label ?? "Opening browser…"}</span>}
      </div>
      <div class="browser-window-actions">
        <details class="browser-menu"><summary aria-label="Browser actions">more</summary>
          <div><span>{instance?.label ?? "Browser"}</span><button type="button" onClick={() => void stop()} disabled={busy || !connected}>stop browser</button></div>
        </details>
        <button type="button" aria-label={expanded ? "Restore browser view" : "Expand browser view"} onClick={() => setExpanded(value => !value)}>{expanded ? "restore" : "expand"}</button>
        <button type="button" aria-label="Close browser view" title="Close view · browser keeps running" onClick={close}>close <kbd>esc</kbd></button>
      </div>
    </header>
    <div class="browser-toolbar">
      <div class="browser-address" title={tab?.url}>{tab?.url === "about:blank" ? "New tab" : tab?.url ?? "Connecting…"}</div>
      <button type="button" class={`browser-follow${selectedTab === undefined ? " is-following" : ""}`} aria-pressed={selectedTab === undefined}
        title="Follow Ship’s active tab" onClick={() => setSelectedTab(undefined)}>{selectedTab === undefined ? "following Ship" : "follow Ship"}</button>
    </div>
    {data?.handoff && <div class="browser-help"><span>{data.handoff.purpose}</span><button type="button" onClick={() => void finish()} disabled={busy || !connected}>continue</button></div>}
    {error && <p class="error" role="alert">{error}</p>}
    {instanceQuery.error && <p class="error" role="alert">{String(instanceQuery.error)}</p>}
    {frameError && ready && <p class="browser-notice" role="status" title={frameError}>View interrupted. Reconnecting…</p>}
    {instance && !ready && <p class="browser-notice" role="status">{instance.state === "starting" ? "Starting browser…" : instance.state === "stopping" ? "Stopping browser…" : "This browser has stopped."}</p>}
    {!connected && <p class="browser-notice" role="alert">Disconnected. Reconnecting…</p>}
    <div class="browser-screen" onClick={event => { if (image.current) { input({ kind: "click", ...point(event) }); keyboard.current?.focus({ preventScroll: true }); } }}
      onWheel={event => { event.preventDefault(); if (image.current) input({ kind: "scroll", ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }); }}>
      {view ? <img ref={image} src={view.source} onLoad={() => { displayed.current = view.data; }} alt="Live cloud browser page" draggable={false} /> : ready && <p>Connecting to the browser…</p>}
      {pointer && <div class={`browser-pointer is-${pointer.actor}`} style={{ left: `${pointer.x / (data?.width ?? 1280) * 100}%`, top: `${pointer.y / (data?.height ?? 800) * 100}%` }} aria-label={pointer.actor === "ship" ? "Ship cursor" : "Your cursor"}>
        <svg width="20" height="27" viewBox="0 0 20 27" aria-hidden="true"><path d="M2 2V21L7 16L11 25L15 23L11 15H19Z" fill="currentColor" stroke="white" stroke-width="1.5" /></svg>
        <span>{pointer.actor === "ship" ? "Ship" : "You"}</span>
        {pointer.clickedAt && <i class="browser-click" key={pointer.clickedAt} />}
      </div>}
      <textarea ref={keyboard} class="browser-keyboard" aria-label="Type in the selected browser field" autoComplete="off" autoCapitalize="off" spellcheck={false}
        onInput={event => { if (event.isComposing) return; const value = event.currentTarget.value; event.currentTarget.value = ""; if (value) input({ kind: "text", text: value }); }}
        onCompositionEnd={event => { const value = event.currentTarget.value; event.currentTarget.value = ""; if (value) input({ kind: "text", text: value }); }}
        onKeyDown={event => {
          if (event.isComposing || (event.key.length === 1 && !event.ctrlKey && !event.metaKey)) return;
          if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
          event.preventDefault();
          const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
          if (!["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "a", "c", "x", "z"].includes(key)) return;
          input({ kind: "key", key, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        }} onPaste={event => { event.preventDefault(); const text = event.clipboardData?.getData("text/plain"); if (text) input({ kind: "text", text }); }} />
    </div>
  </dialog>;
}
