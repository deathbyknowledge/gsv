import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { invoke } from "./bridge";
import type { TextKey } from "../app/i18n/locale";

/** Window lifecycle belongs to the app, including welcome and session loading. */
export function useDesktopQuit(flush: (() => Promise<void>) | undefined, onError: (message: TextKey) => void) {
  const [confirmation, setConfirmation] = useState(false);
  const quitting = useRef(false);
  const quit = useCallback(() => {
    if (quitting.current) return;
    quitting.current = true;
    void Promise.resolve().then(() => flush?.()).then(() => invoke("desktop_quit")).catch(() => {
      quitting.current = false;
      onError("desktop.errors.quit");
    });
  }, [flush, onError]);
  const requestQuit = useCallback(() => {
    // Reuse every retained view's unload guard without navigating or unloading the page.
    if (window.dispatchEvent(new Event("beforeunload", { cancelable: true }))) quit();
    else setConfirmation(true);
  }, [quit]);
  const current = useRef(requestQuit);
  useLayoutEffect(() => { current.current = requestQuit; }, [requestQuit]);
  useEffect(() => {
    if (!window.__TAURI__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window.__TAURI__.window.getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (!disposed) current.current();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => onError("desktop.errors.closeAction"));
    return () => { disposed = true; unlisten?.(); };
  }, [onError]);
  return { requestQuit, quit, confirmation, cancel: () => setConfirmation(false) };
}
