import { useEffect, useMemo, useState } from "preact/hooks";
import { App } from "../app/App";
import { AuthScene } from "../app/features/session/AuthLayout";
import { NativeInputProvider } from "../app/services/platform/PlatformProvider";
import { configureGatewayOrigin } from "../app/services/platform/gatewayOrigin";
import { createSessionService, type SessionService } from "../app/services/session/sessionService";
import { invoke, nativeInput, nativeSessionStorage, type DesktopSession } from "./bridge";
import { InputTimingPanel } from "./InputTimingPanel";
import "./desktop.css";

function ConnectedDesktop({ session, mock, onError }: { session: DesktopSession; mock: boolean; onError(message: string): void }) {
  const [service, setService] = useState<SessionService | null>(null);
  const [locked, setLocked] = useState(true);
  const [confirmation, setConfirmation] = useState<"disconnect" | "quit" | null>(null);
  const input = useMemo(() => nativeInput(session.generation), [session.generation]);
  const storage = useMemo(() => nativeSessionStorage(session, onError, mock), [session.generation]);
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
    setConfirmation(null);
    service?.lock("Disconnected");
    service?.dispose?.();
    try {
      await invoke("desktop_configure", { origin: null });
      window.sessionStorage.clear();
      window.localStorage.clear();
      window.location.replace("/");
    } catch { onError("Could not clear the configured space. Try again."); }
  };
  return <>
    <div class="desktop-strip">
      <span>GSV Tauri Prototype · {mock ? "mock gateway" : new URL(session.origin!).host}</span>
      {locked && !mock && <button type="button" onClick={() => void invoke("desktop_open", { url: `${session.origin}/recover-member` }).catch(() => onError("Could not open your browser."))}>recover in browser</button>}
      <InputTimingPanel />
      <button type="button" onClick={() => setConfirmation("disconnect")}>disconnect space</button>
      <button type="button" onClick={() => setConfirmation("quit")}>quit</button>
    </div>
    {confirmation && <div class="desktop-confirm" role="alertdialog" aria-label="Discard unsent work?">
      <p>{confirmation === "disconnect" ? "Disconnect this space?" : "Quit the prototype?"} Unsent work will be discarded.</p>
      <button type="button" onClick={() => setConfirmation(null)}>keep working</button>
      <button type="button" onClick={() => {
        if (confirmation === "disconnect") void disconnect();
        else void invoke("desktop_quit").catch(() => onError("Could not quit the prototype."));
      }}>{confirmation === "disconnect" ? "disconnect" : "quit"}</button>
    </div>}
    <NativeInputProvider input={input}><App createSessionService={factory} /></NativeInputProvider>
  </>;
}

export function DesktopApp() {
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";
  useEffect(() => {
    void invoke<DesktopSession>("desktop_session").then((value) => {
      if (mock) value = { ...value, origin: null, values: {
        "gsv.ui.session.token.v1": JSON.stringify({ username: "esteve", tokenId: "desktop-mock", token: "mock-session-token", expiresAt: null }),
      } };
      setSession(value);
    }).catch(() => setError("Open this frontend with the prototype executable."));
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
      void invoke("desktop_open", { url: url.href }).catch(() => setError("Could not open your browser."));
    };
    document.addEventListener("click", links, true);
    return () => document.removeEventListener("click", links, true);
  }, [mock, session?.origin]);

  return <div class="desktop-root">
    {error && <div class="desktop-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>dismiss</button></div>}
    {session && (session.origin || mock) ? <ConnectedDesktop key={`${session.generation}:${mock}`} session={session} mock={mock} onError={setError} /> :
      <AuthScene setup={false}><form class="desktop-connect" onSubmit={(event) => {
        event.preventDefault(); setBusy(true); setError(null);
        void invoke<DesktopSession>("desktop_configure", { origin }).then((next) => {
          window.sessionStorage.clear(); window.localStorage.clear(); setSession(next);
        }).catch(() => setError("Use an HTTPS space address, such as https://your-space.example. HTTP is allowed for localhost."))
          .finally(() => setBusy(false));
      }}>
        <h1>GSV Tauri Prototype</h1>
        <p>Connect one space. Sign in with your existing account on the next screen.</p>
        <label>Space address<input type="url" required value={origin} placeholder="https://your-space.example" onInput={(event) => setOrigin(event.currentTarget.value)} /></label>
        <button type="submit" disabled={busy || !session}>{busy ? "connecting…" : "continue"}</button>
        {import.meta.env.DEV && <a href="/?mock=1">open the development mock</a>}
      </form></AuthScene>}
  </div>;
}
