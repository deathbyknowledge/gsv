import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { App } from "../app/App";
import { AuthScene } from "../app/features/session/AuthLayout";
import { BrowserNavigationProvider } from "../app/services/platform/BrowserNavigation";
import { NativeInputProvider } from "../app/services/platform/PlatformProvider";
import { PlatformIdentityProvider } from "../app/services/platform/PlatformIdentity";
import { configureGatewayOrigin } from "../app/services/platform/gatewayOrigin";
import { createSessionService, type SessionService } from "../app/services/session/sessionService";
import { disconnectSpace, invoke, nativeInput, nativeSessionStorage, openInBrowser, type DesktopSession } from "./bridge";
import { DesktopSpaceMenu } from "./DesktopSpaceMenu";
import { ClientControlProvider } from "../app/services/platform/ClientControl";
import { desktopControl } from "./control";
import "./desktop.css";

function ConnectedDesktop({ session, mock, onError }: { session: DesktopSession; mock: boolean; onError(message: string): void }) {
  const [service, setService] = useState<SessionService | null>(null);
  const [locked, setLocked] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectPending = useRef(false);
  const storage = useMemo(() => nativeSessionStorage(session, onError, mock), [session.generation]);
  const [confirmation, setConfirmation] = useState<"disconnect" | "quit" | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    // A native close request must remain actionable above any open Instrument dialog.
    if (confirmation && !dialog.open) dialog.showModal();
    if (!confirmation && dialog.open) dialog.close();
  }, [confirmation]);
  const quitting = useRef(false);
  const quit = useCallback(() => {
    if (quitting.current) return;
    quitting.current = true;
    void storage.flush().then(() => invoke("desktop_quit")).catch(() => {
      quitting.current = false;
      onError("Could not quit GSV.");
    });
  }, [onError, storage]);
  const requestQuit = useCallback(() => {
    // Reuse every retained view's unload guard without navigating or unloading the page.
    if (window.dispatchEvent(new Event("beforeunload", { cancelable: true }))) quit();
    else setConfirmation("quit");
  }, [quit]);
  useEffect(() => {
    if (!window.__TAURI__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window.__TAURI__.window.getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (!disposed) requestQuit();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => onError("Could not connect the window close action. Use Quit to exit."));
    return () => { disposed = true; unlisten?.(); };
  }, [onError, requestQuit]);
  const input = useMemo(() => nativeInput(session.generation), [session.generation]);
  const control = useMemo(() => desktopControl(session.generation), [session.generation]);
  useEffect(() => control.attach(), [control]);
  const factory = useMemo(() => (client: Parameters<typeof createSessionService>[0]) => {
    const origin = session.origin ?? "http://localhost:5186";
    configureGatewayOrigin(origin);
    const ws = new URL("/ws", origin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    const instance = createSessionService(client, { url: ws.href, storage, onboarding: false });
    // The service is created while App renders. Defer the parent's presentation update.
    queueMicrotask(() => setService(instance));
    return instance;
  }, [session.generation]);
  useEffect(() => service?.subscribe((snapshot) => {
    setLocked(snapshot.phase !== "ready");
    if (snapshot.phase === "locked") window.sessionStorage.clear();
  }), [service]);

  const disconnect = async () => {
    if (!service || disconnectPending.current) return;
    disconnectPending.current = true;
    setDisconnecting(true);
    try {
      await disconnectSpace(service, storage);
      window.sessionStorage.clear();
      window.localStorage.clear();
      window.location.replace("/");
    } catch {
      onError("Could not disconnect the space. Try again.");
      setConfirmation(null);
    } finally {
      disconnectPending.current = false;
      setDisconnecting(false);
    }
  };
  return <>
    <dialog ref={confirmationDialog} class="desktop-confirm" role="alertdialog" aria-label="Discard unsent work?"
      onCancel={(event) => { event.preventDefault(); if (!disconnecting) setConfirmation(null); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <p>{confirmation === "disconnect" ? "Disconnect this space?" : "Quit GSV?"} Unsent work will be discarded.</p>
      <button type="button" disabled={disconnecting} onClick={() => setConfirmation(null)}>keep working</button>
      <button type="button" disabled={disconnecting || (confirmation === "disconnect" && !service)} onClick={() => {
        if (confirmation === "disconnect") void disconnect();
        else quit();
      }}>{confirmation === "disconnect" ? disconnecting ? "disconnecting…" : "disconnect" : "quit"}</button>
    </dialog>
    <PlatformIdentityProvider identity={<DesktopSpaceMenu origin={mock ? null : session.origin} locked={locked}
      onRecover={() => void openInBrowser(`${session.origin}/recover-member`).catch(() => onError("Could not open your browser."))}
      onDisconnect={() => setConfirmation("disconnect")} onQuit={requestQuit} />}>
      <ClientControlProvider control={control}><NativeInputProvider input={input}><App createSessionService={factory} /></NativeInputProvider></ClientControlProvider>
    </PlatformIdentityProvider>
  </>;
}

export function DesktopApp() {
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";
  useEffect(() => {
    void invoke("desktop_session").then((value) => {
      if (mock) value = { ...value, origin: null, values: {
        "gsv.ui.session.token.v1": JSON.stringify({ username: "esteve", tokenId: "desktop-mock", token: "mock-session-token", expiresAt: null }),
      } };
      setSession(value);
    }).catch(() => setError("Open this frontend with GSV Desktop."));
  }, [mock]);

  useEffect(() => {
    // Relative recovery routes belong to the chosen gateway's external browser.
    const links = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin && !["/recover", "/recover-member", "/join", "/onboarding"].includes(url.pathname)) return;
      if (url.origin === window.location.origin) {
        if (!session?.origin) return;
        const gateway = new URL(session.origin);
        url.protocol = gateway.protocol; url.host = gateway.host;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      event.preventDefault(); event.stopImmediatePropagation();
      void openInBrowser(url.href).catch(() => setError("Could not open your browser."));
    };
    document.addEventListener("click", links, true);
    return () => document.removeEventListener("click", links, true);
  }, [mock, session?.origin]);

  return <BrowserNavigationProvider navigate={openInBrowser}><div class="desktop-root">
    {error && <div class="desktop-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>dismiss</button></div>}
    {session && (session.origin || mock) ? <ConnectedDesktop key={`${session.generation}:${mock}`} session={session} mock={mock} onError={setError} /> :
      <AuthScene setup={false}><form class="desktop-connect" onSubmit={(event) => {
        event.preventDefault(); setBusy(true); setError(null);
        void invoke("desktop_configure", { origin }).then((next) => {
          window.sessionStorage.clear(); window.localStorage.clear(); setSession(next);
        }).catch(() => setError("Use an HTTPS space address, such as https://your-space.example. HTTP is allowed for localhost."))
          .finally(() => setBusy(false));
      }}>
        <h1>GSV</h1>
        <label>Space address<input type="url" required value={origin} placeholder="https://your-space.example" onInput={(event) => setOrigin(event.currentTarget.value)} /></label>
        <button type="submit" disabled={busy || !session}>{busy ? "connecting…" : "continue"}</button>
        {import.meta.env.DEV && <a href="/?mock=1">open the development mock</a>}
      </form></AuthScene>}
  </div></BrowserNavigationProvider>;
}
