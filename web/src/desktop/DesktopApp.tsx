import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { App } from "../app/App";
import { AuthScene } from "../app/features/session/AuthLayout";
import { BrowserNavigationProvider } from "../app/services/platform/BrowserNavigation";
import { NativeInputProvider } from "../app/services/platform/PlatformProvider";
import { PlatformIdentityProvider } from "../app/services/platform/PlatformIdentity";
import { configureGatewayOrigin } from "../app/services/platform/gatewayOrigin";
import { createSessionService, type SessionService } from "../app/services/session/sessionService";
import { disconnectSpace, invoke, nativeInput, nativeSessionStorage, openInBrowser, type DesktopSession, type NativeSessionStorage } from "./bridge";
import { DesktopSpaceMenu } from "./DesktopSpaceMenu";
import { DesktopMachineSetup } from "./DesktopMachineSetup";
import { DesktopWelcome } from "./DesktopWelcome";
import { DesktopAttachments } from "./DesktopAttachments";
import { ONBOARDING_KEY } from "../app/services/session/ownerWelcome";
import { completeDesktopOnboarding } from "./welcome";
import { ClientControlProvider } from "../app/services/platform/ClientControl";
import { desktopControl } from "./control";
import { useDesktopQuit } from "./useDesktopQuit";
import "./desktop.css";

function ConnectedDesktop({ session, storage, mock, onError, onQuit }: {
  session: DesktopSession; storage: NativeSessionStorage; mock: boolean; onError(message: string): void; onQuit(): void;
}) {
  const [service, setService] = useState<SessionService | null>(null);
  const [locked, setLocked] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [machineRequest, setMachineRequest] = useState(0);
  const disconnectPending = useRef(false);
  const [confirmation, setConfirmation] = useState(false);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    if (confirmation && !dialog.open) dialog.showModal();
    if (!confirmation && dialog.open) dialog.close();
  }, [confirmation]);
  const input = useMemo(() => nativeInput(session.generation), [session.generation]);
  const control = useMemo(() => desktopControl(session.generation), [session.generation]);
  useEffect(() => control.attach(), [control]);
  const factory = useMemo(() => (client: Parameters<typeof createSessionService>[0]) => {
    const origin = session.origin ?? "http://localhost:5186";
    configureGatewayOrigin(origin);
    const ws = new URL("/ws", origin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    const token = storage.getItem(ONBOARDING_KEY);
    const instance = createSessionService(client, { url: ws.href, storage, onboarding: token ? {
      token, complete: () => completeDesktopOnboarding(storage),
    } : false });
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
      setConfirmation(false);
    } finally {
      disconnectPending.current = false;
      setDisconnecting(false);
    }
  };
  return <>
    <dialog ref={confirmationDialog} class="desktop-confirm" role="alertdialog" aria-label="Discard unsent work?"
      onCancel={(event) => { event.preventDefault(); if (!disconnecting) setConfirmation(false); }}
      onKeyDown={(event) => event.stopPropagation()}>
      <p>Disconnect this space? Unsent work will be discarded.</p>
      <button type="button" disabled={disconnecting} onClick={() => setConfirmation(false)}>keep working</button>
      <button type="button" disabled={disconnecting || !service} onClick={() => void disconnect()}>{disconnecting ? "disconnecting…" : "disconnect"}</button>
    </dialog>
    <PlatformIdentityProvider identity={<><DesktopSpaceMenu origin={mock ? null : session.origin} locked={locked}
      onRecover={() => void openInBrowser(`${session.origin}/recover-member`).catch(() => onError("Could not open your browser."))}
      onMachine={!locked && !mock ? () => setMachineRequest((value) => value + 1) : undefined}
      onDisconnect={() => setConfirmation(true)} onQuit={onQuit} />
      {!locked && !mock && session.origin && <DesktopMachineSetup origin={session.origin} generation={session.generation}
        request={machineRequest} storage={storage} />}</>}>
      <DesktopAttachments active={!locked}>
        <ClientControlProvider control={control}><NativeInputProvider input={input}><App createSessionService={factory} /></NativeInputProvider></ClientControlProvider>
      </DesktopAttachments>
    </PlatformIdentityProvider>
  </>;
}

export function DesktopApp() {
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeSetup, setResumeSetup] = useState(false);
  const mock = import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "1";
  const storage = useMemo(() => session ? nativeSessionStorage(session, setError, mock) : null, [session?.generation, mock]);
  const { requestQuit, quit, confirmation, cancel } = useDesktopQuit(storage?.flush, setError);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = confirmationDialog.current;
    if (!dialog) return;
    // A native close request must remain actionable above any open Instrument dialog.
    if (confirmation && !dialog.open) dialog.showModal();
    if (!confirmation && dialog.open) dialog.close();
  }, [confirmation]);
  useEffect(() => {
    void invoke("desktop_session").then((value) => {
      if (mock) value = { ...value, origin: null, values: {
        "gsv.ui.session.token.v1": JSON.stringify({ username: "esteve", tokenId: "desktop-mock", token: "mock-session-token", expiresAt: null }),
      } };
      setSession(value);
      setResumeSetup(!mock && !!value.values[ONBOARDING_KEY]);
    }).catch(() => setError("Open this frontend with GSV Desktop."));
  }, [mock]);

  useEffect(() => {
    // Relative recovery routes belong to the chosen gateway's external browser.
    const links = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
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
    document.addEventListener("click", links);
    return () => document.removeEventListener("click", links);
  }, [mock, session?.origin]);

  return <BrowserNavigationProvider navigate={openInBrowser}><div class="desktop-root">
    <dialog ref={confirmationDialog} class="desktop-confirm" role="alertdialog" aria-label="Discard unsent work?"
      onCancel={(event) => { event.preventDefault(); cancel(); }} onKeyDown={(event) => event.stopPropagation()}>
      <p>Quit GSV? Unsent work will be discarded.</p>
      <button type="button" onClick={cancel}>keep working</button>
      <button type="button" onClick={quit}>quit</button>
    </dialog>
    {error && <div class="desktop-error" role="alert">{error}<button type="button" onClick={() => setError(null)}>dismiss</button></div>}
    {session && storage && !resumeSetup && (session.origin || mock) ? <ConnectedDesktop key={`${session.generation}:${mock}`} session={session} storage={storage} mock={mock} onError={setError} onQuit={requestQuit} /> :
      <PlatformIdentityProvider identity={<button type="button" onClick={requestQuit}>quit</button>}>
      <AuthScene layout="welcome"><DesktopWelcome ready={!!session} resume={resumeSetup} onConnect={async (origin, onboardingToken) => {
        setError(null);
        const next = await invoke("desktop_configure", { origin, onboardingToken });
        window.sessionStorage.clear(); window.localStorage.clear(); setResumeSetup(false); setSession(next);
      }} /></AuthScene></PlatformIdentityProvider>}
  </div></BrowserNavigationProvider>;
}
