import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useSession } from "../../../services/session/SessionProvider";
import { sendBrowserInput } from "../../../services/instances/browserControl";
import type { BrowserHumanInput } from "@humansandmachines/gsv/protocol";
import { INSTANCE_QUERY_KEY } from "../wire/queryKeys";
import { useBrowserStream, type BrowserImage } from "./useBrowserStream";
import { useT } from "../../../i18n/locale";
import "./browser.css";

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
  return useQuery({ queryKey: INSTANCE_QUERY_KEY, queryFn: () => client.sys.instance.list({}), enabled: connected && available });
}

export function BrowserRequests() {
  const t = useT();
  const { open, available } = useBrowserControl();
  const query = useCloudInstances();
  if (!available || !query.data?.handoffs.length) return null;
  return <section class="browser-requests" aria-label={t("browser.requests")}>
    {query.data.handoffs.map(request => <div class="browser-request" key={`${request.instanceId}/${request.requestId}`}>
      <div><strong>{request.purpose}</strong><span>{request.site} · {t("browser.minutesLeft", { count: Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 60000)) })}</span></div>
      <button type="button" class="fleet-text-action is-primary" disabled={!request.site} onClick={() => open(request)}>{request.site ? t("browser.open") : t("browser.preparing")}</button>
    </div>)}
  </section>;
}

/** A failure shown in the viewer: as reported, or after the viewer's own lead-in when the person's input went unconfirmed. */
type ViewerError = { cause: string; duringInput?: true };

export function BrowserViewer({ request, onClose }: { request: BrowserSelection; onClose: () => void }) {
  const t = useT();
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const instanceQuery = useQuery({ queryKey: ["cloud-instance", request.instanceId], queryFn: () => client.sys.instance.get({ instanceId: request.instanceId }), enabled: connected });
  const instance = instanceQuery.data?.instance;
  const ready = instance?.state === "ready";
  const dialog = useRef<HTMLDialogElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const displayed = useRef<BrowserImage | null>(null);
  const [selectedTab, setSelectedTab] = useState<number>();
  const [error, setError] = useState<ViewerError | null>(null);
  const [completedRequestId, setCompletedRequestId] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const { frame: view, state: viewState, error: frameError, selection } = useBrowserStream(client, request.instanceId, selectedTab, connected && ready);
  const handoff = viewState?.handoff?.requestId === completedRequestId ? undefined : viewState?.handoff;
  // Only a completion confirmed in this viewer releases its original action link.
  const requestMatches = request.requestId === undefined || completedRequestId !== undefined || handoff?.requestId === request.requestId;
  const requestUnavailable = viewState !== undefined && !requestMatches && !finishing;
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
  useLayoutEffect(() => { inputEpoch.current++; }, [request.requestId, handoff?.requestId, handoff?.state]);
  useEffect(() => {
    if (!completedRequestId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("browserInstance") !== request.instanceId || url.searchParams.get("browserHandoff") !== completedRequestId) return;
    url.searchParams.delete("browserHandoff");
    window.history.replaceState(window.history.state, "", url);
  }, [completedRequestId, request.instanceId]);
  useEffect(() => {
    if (!connected || !requestMatches || handoff?.state !== "pending" || !handoff.site) return;
    let current = true;
    void client.sys.browser.handoff.open({ instanceId: request.instanceId, requestId: handoff.requestId })
      .catch(cause => { if (current) setError({ cause: String(cause) }); });
    return () => { current = false; };
  }, [client, connected, request.instanceId, requestMatches, handoff?.requestId, handoff?.state, handoff?.site]);

  const input = (value: BrowserHumanInput) => {
    const displayedFrame = displayed.current;
    const shown = displayedFrame?.data;
    if (!live.current || !requestMatches || busy || !shown || displayedFrame.signal.aborted || displayedFrame.selection !== selection || (handoff && handoff.state !== "active")) return;
    if (value.kind === "click") setSelectedTab(shown.tabId);
    const epoch = inputEpoch.current;
    const args = { instanceId: request.instanceId, tabId: shown.tabId, documentId: shown.documentId, handoffRequestId: handoff?.requestId };
    inputQueue.current = inputQueue.current.then(async () => {
      if (!live.current || inputEpoch.current !== epoch || displayedFrame.signal.aborted) return;
      await sendBrowserInput(client, args, value);
      setError(null);
    }).catch(cause => { inputEpoch.current++; setError({ cause: String(cause), duringInput: true }); });
  };
  const selectTab = (tabId: number | undefined) => {
    if (tabId === selectedTab) return;
    displayed.current = null;
    inputEpoch.current++;
    setSelectedTab(tabId);
  };
  const close = () => { live.current = false; inputEpoch.current++; onClose(); };
  const finish = async () => {
    if (!requestMatches || !handoff || busy) return;
    const epoch = inputEpoch.current;
    setBusy(true);
    try {
      await inputQueue.current;
      if (!live.current || inputEpoch.current !== epoch) return;
      inputEpoch.current++;
      setFinishing(true);
      const result = await client.sys.browser.handoff.finish({ instanceId: request.instanceId, requestId: handoff.requestId });
      if (result.handoff.state === "completed") {
        setCompletedRequestId(handoff.requestId);
        selectTab(undefined);
      }
      setError(null);
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY });
    } catch (cause) { setError({ cause: String(cause) }); }
    finally { setFinishing(false); setBusy(false); }
  };
  const stop = async (force = false) => {
    setBusy(true); live.current = false; inputEpoch.current++;
    try {
      await client.sys.instance.stop({ instanceId: request.instanceId, force: force || undefined });
      await queryClient.invalidateQueries({ queryKey: INSTANCE_QUERY_KEY });
      onClose();
    } catch (cause) { setError({ cause: String(cause) }); setBusy(false); live.current = connected; await instanceQuery.refetch(); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { await client.sys.browser.profile.save({ instanceId: request.instanceId }); }
    catch (cause) { setError({ cause: String(cause) }); }
    finally { setBusy(false); await instanceQuery.refetch(); }
  };
  const point = (event: MouseEvent | WheelEvent) => {
    const bounds = image.current!.getBoundingClientRect();
    const width = displayed.current?.data.width ?? 1280, height = displayed.current?.data.height ?? 800;
    return { x: Math.max(0, Math.min(width, (event.clientX - bounds.left) * width / bounds.width)), y: Math.max(0, Math.min(height, (event.clientY - bounds.top) * height / bounds.height)) };
  };
  const data = view && viewState ? { ...viewState, ...view.data } : undefined;
  const tab = data?.tabs.find(tab => tab.id === data.tabId);
  const pointer = data?.pointer?.tabId === data?.tabId ? data?.pointer : undefined;
  return <dialog ref={dialog} class={`browser-viewer${expanded ? " is-expanded" : ""}`} aria-label={t("browser.viewer")} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => event.stopPropagation()}>
    <header class="browser-chrome">
      <div class="browser-tabs" role="tablist" aria-label={t("browser.tabs")}>
        {data?.tabs.map((item, index) => <button type="button" role="tab" aria-selected={item.id === data.tabId} tabIndex={item.id === data.tabId ? 0 : -1} key={item.id}
          onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % data.tabs.length : event.key === "ArrowLeft" ? (index + data.tabs.length - 1) % data.tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? data.tabs.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            selectTab(data.tabs[next]!.id);
            const button = event.currentTarget.parentElement?.children[next];
            if (button instanceof HTMLButtonElement) button.focus();
          }}
          title={item.url} onClick={() => selectTab(item.id)}>{item.url === "about:blank" ? t("browser.newTab") : item.title || item.url}</button>)}
        {!data && <span class="browser-tab-loading">{instance?.label ?? t("browser.opening")}</span>}
      </div>
      <div class="browser-window-actions">
        <details class="browser-menu"><summary aria-label={t("browser.actions")}>{t("browser.more")}</summary>
          <div><span>{instance?.label ?? t("browser.name")}</span><button type="button" onClick={() => void stop()} disabled={busy || !connected}>{t("browser.stop")}</button></div>
          {instance?.profileId && <small aria-live="polite">{instance.persistence?.saveStatus === "saving" ? t("browser.save.saving")
            : instance.persistence?.saveStatus === "failed" ? t("browser.save.unsaved")
            : instance.persistence?.saveStatus === "partial" ? t("browser.save.partial")
            : instance.persistence?.savedAt ? t("browser.save.savedAt", { time: new Date(instance.persistence.savedAt).toLocaleTimeString() }) : t("browser.save.none")}</small>}
        </details>
        <button type="button" aria-label={expanded ? t("browser.restoreView") : t("browser.expandView")} onClick={() => setExpanded(value => !value)}>{expanded ? t("browser.restore") : t("browser.expand")}</button>
        <button type="button" aria-label={t("browser.closeView")} title={t("browser.closeHint")} onClick={close}>{t("browser.close")} <kbd>esc</kbd></button>
      </div>
    </header>
    <div class="browser-toolbar">
      <div class="browser-address" title={tab?.url}>{tab?.url === "about:blank" ? t("browser.newTab") : tab?.url ?? t("fleet.connecting")}</div>
      <button type="button" class={`browser-follow${selectedTab === undefined ? " is-following" : ""}`} aria-pressed={selectedTab === undefined}
        title={t("browser.followHint")} onClick={() => selectTab(undefined)}>{selectedTab === undefined ? t("browser.following") : t("browser.follow")}</button>
    </div>
    {requestUnavailable && <p class="browser-notice" role="status">{t("browser.handoff.ended")}</p>}
    {finishing && <p class="browser-notice" role="status">{t("browser.handoff.finishing")}</p>}
    {!finishing && completedRequestId && !handoff && <p class="browser-notice" role="status">{t("browser.handoff.done")}</p>}
    {!finishing && requestMatches && handoff && <div class="browser-help"><span>{handoff.purpose}</span><button type="button" onClick={() => void finish()} disabled={busy || !connected || handoff.state !== "active"}>{t("browser.handoff.finish")}</button></div>}
    {error && <p class="error" role="alert">{error.duringInput ? t("browser.inputUnconfirmed", { error: error.cause }) : error.cause}</p>}
    {instanceQuery.error && <p class="error" role="alert">{String(instanceQuery.error)}</p>}
    {ready && instance?.persistence?.issues?.length && instance.persistence.saveStatus !== "failed" ? <div class="browser-help" role="status">
      <span>{t("browser.save.issues", { hosts: instance.persistence.issues.map(issue => new URL(issue.origin).host).join(", ") })}</span>
      {instance.persistence.issues.some(issue => issue.reason === "unavailable") && <button type="button" onClick={() => void save()} disabled={busy || !connected}>{t("browser.save.retry")}</button>}
    </div> : null}
    {ready && instance?.persistence?.saveStatus === "failed" && <div class="browser-help" role="alert">
      <span>{instance.persistence.error ?? t("browser.save.failed")} {instance.persistence.savedAt ? t("browser.save.lastSaved", { time: new Date(instance.persistence.savedAt).toLocaleTimeString() }) : t("browser.save.noneYet")}</span>
      <button type="button" onClick={() => void save()} disabled={busy || !connected}>{t("browser.save.retry")}</button>
      <button type="button" onClick={() => void stop(true)} disabled={busy || !connected}>{t("browser.stopUnsaved")}</button>
    </div>}
    {frameError && ready && <p class="browser-notice" role="status" title={frameError}>{t("browser.interrupted")}</p>}
    {instance && !ready && <p class="browser-notice" role="status">{instance.state === "starting" ? t("browser.starting") : instance.state === "stopping" ? t("browser.stopping") : t("browser.stopped")}</p>}
    {!connected && <p class="browser-notice" role="alert">{t("browser.disconnected")}</p>}
    <div class="browser-screen" onClick={event => { if (image.current) { input({ kind: "click", ...point(event) }); keyboard.current?.focus({ preventScroll: true }); } }}
      onWheel={event => { event.preventDefault(); if (image.current) input({ kind: "scroll", ...point(event), deltaX: event.deltaX, deltaY: event.deltaY }); }}>
      {view ? <img ref={image} src={view.source} onLoad={() => { displayed.current = view; view.presented(); }} alt={t("browser.page")} draggable={false} /> : ready && <p>{t("browser.connecting")}</p>}
      {pointer && <div class={`browser-pointer is-${pointer.actor}`} style={{ left: `${pointer.x / (data?.width ?? 1280) * 100}%`, top: `${pointer.y / (data?.height ?? 800) * 100}%` }} aria-label={pointer.actor === "ship" ? t("browser.cursor.ship") : t("browser.cursor.you")}>
        <svg width="20" height="27" viewBox="0 0 20 27" aria-hidden="true"><path d="M2 2V21L7 16L11 25L15 23L11 15H19Z" fill="currentColor" stroke="white" stroke-width="1.5" /></svg>
        <span>{pointer.actor === "ship" ? "Ship" : t("browser.cursor.youName")}</span>
        {pointer.clickedAt && <i class="browser-click" key={pointer.clickedAt} />}
      </div>}
      <textarea ref={keyboard} class="browser-keyboard" aria-label={t("browser.keyboard")} autoComplete="off" autoCapitalize="off" spellcheck={false}
        disabled={!requestMatches || busy || !view || view.signal.aborted || view.selection !== selection || (handoff !== undefined && handoff.state !== "active")}
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
