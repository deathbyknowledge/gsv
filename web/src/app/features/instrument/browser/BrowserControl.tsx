import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { browserFrame, sendBrowserInput } from "../../../services/instances/browserControl";
import type { BrowserHandoff, BrowserHumanInput, SysBrowserHandoffGetArgs } from "@humansandmachines/gsv/protocol";
import { INSTRUMENT_TARGETS_KEY } from "../wire/queryKeys";
import "./browser.css";

export const INSTANCE_QUERY_KEY = ["cloud-instances"];
export const PROFILE_QUERY_KEY = ["browser-profiles"];
type BrowserControlContext = { available: boolean; selection: SysBrowserHandoffGetArgs | null; open: (request: SysBrowserHandoffGetArgs) => void; close: () => void };
const Context = createContext<BrowserControlContext>({ available: false, selection: null, open: () => {}, close: () => {} });
export function useBrowserControl() { return useContext(Context); }

export function BrowserControlProvider({ children }: { children: ComponentChildren }) {
  const { snapshot } = useSession();
  const available = snapshot.server?.features?.includes("cloud-instances") ?? false;
  const [selection, setSelection] = useState<SysBrowserHandoffGetArgs | null>(() => {
    const query = new URLSearchParams(window.location.search);
    const instanceId = query.get("browserInstance"), requestId = query.get("browserHandoff");
    return instanceId && requestId ? { instanceId, requestId } : null;
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

function BrowserViewer({ request, onClose }: { request: SysBrowserHandoffGetArgs; onClose: () => void }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [handoff, setHandoff] = useState<BrowserHandoff | null>(null);
  const [tabs, setTabs] = useState<Array<{ id: number; title: string; url: string }>>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [finishing, setFinishing] = useState(false);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const controlActive = useRef(false);
  useLayoutEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    if (!connected) { controlActive.current = false; return; }
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, url: string | undefined;
    const frame = async () => {
      try {
        const result = await browserFrame(client, request, lifetime.signal);
        if (lifetime.signal.aborted) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(result.image); setSource(url); setHandoff(result.data.handoff); setTabs(result.data.tabs);
        timer = setTimeout(() => void frame(), 400);
      } catch (cause) { if (!lifetime.signal.aborted) { controlActive.current = false; setError(String(cause)); } }
    };
    void client.sys.browser.handoff.open(request).then(result => {
      if (lifetime.signal.aborted) return;
      setHandoff(result.handoff); controlActive.current = true; void frame();
    }, cause => { if (!lifetime.signal.aborted) setError(String(cause)); });
    return () => { controlActive.current = false; lifetime.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [client, connected, request.instanceId, request.requestId]);

  const input = (value: BrowserHumanInput) => {
    if (!controlActive.current || finishing) return;
    inputQueue.current = inputQueue.current.then(() => {
      if (!controlActive.current) return;
      return sendBrowserInput(client, request, value);
    }).catch(cause => { controlActive.current = false; setError(`Input could not be confirmed. ${String(cause)}`); });
  };
  const end = async (finish: boolean) => {
    if (finishing) return;
    setFinishing(true);
    try {
      await inputQueue.current;
      controlActive.current = false;
      if (finish) await client.sys.browser.handoff.finish(request);
      else await client.sys.browser.handoff.cancel(request);
      await Promise.all([queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY }), queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY })]);
      onClose();
    } catch (cause) { setError(String(cause)); setFinishing(false); }
  };
  const point = (event: MouseEvent | WheelEvent) => {
    const bounds = image.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1280, (event.clientX - bounds.left) * 1280 / bounds.width)), y: Math.max(0, Math.min(800, (event.clientY - bounds.top) * 800 / bounds.height)) };
  };
  return <dialog ref={dialog} class="browser-viewer" aria-label="Control cloud browser" onCancel={event => { event.preventDefault(); void end(false); }} onKeyDown={event => event.stopPropagation()}>
    <header><div><strong>{handoff?.purpose ?? "Opening browser…"}</strong><span>{handoff?.site}</span></div>
      <button type="button" onClick={() => void end(false)} disabled={finishing}>cancel</button>
      <button type="button" class="is-primary" onClick={() => void end(true)} disabled={!handoff || finishing || !connected}>{finishing ? "Returning control…" : "Done — return to Ship"}</button>
    </header>
    <p class="note">You’re controlling this browser. Ship is paused here while you sign in.</p>
    {tabs.length > 1 && <label class="browser-tabs">Tab<select aria-label="Browser tab" value={handoff?.activeTabId ?? handoff?.tabId} onChange={event => input({ kind: "tab", tabId: Number(event.currentTarget.value) })} disabled={finishing}>{tabs.map(tab => <option value={tab.id}>{tab.title || tab.url || "New tab"}</option>)}</select></label>}
    {error && <p class="error" role="alert">{error}</p>}
    {!connected && <p class="error" role="alert">Disconnected. Reconnect before entering anything.</p>}
    <div class="browser-screen" onClick={event => { if (image.current) { input({ kind: "click", ...point(event) }); keyboard.current?.focus({ preventScroll: true }); } }}
      onWheel={event => { event.preventDefault(); if (image.current) input({ kind: "scroll", ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }); }}>
      {source ? <img ref={image} src={source} alt="Live cloud browser page" draggable={false} /> : <p>Connecting to the browser…</p>}
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
