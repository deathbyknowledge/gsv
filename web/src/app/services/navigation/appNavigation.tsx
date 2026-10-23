import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import { z } from "zod";

export const APP_NAVIGATION = "gsv-app-navigation";
export const BEFORE_APP_NAVIGATION = "gsv-before-app-navigation";

const appHistoryStateSchema = z.looseObject({ gsvAppIndex: z.number().int().safe() });
const browserHistoryStateSchema = z.looseObject({});
export type AppHistoryState = z.infer<typeof appHistoryStateSchema>;

export function appHistoryIndex(): number | null {
  const state = appHistoryStateSchema.safeParse(window.history.state);
  return state.success ? state.data.gsvAppIndex : null;
}

function historyState(index: number): AppHistoryState {
  const state = browserHistoryStateSchema.safeParse(window.history.state);
  if (!state.success) return { gsvAppIndex: index };
  return { ...state.data, gsvAppIndex: index };
}

export function useAppLocation() {
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, revision: 0 }));
  useLayoutEffect(() => {
    if (appHistoryIndex() === null) window.history.replaceState(historyState(0), "", window.location.href);
    const changed = () => setLocation((current) => ({ pathname: window.location.pathname, revision: current.revision + 1 }));
    window.addEventListener(APP_NAVIGATION, changed);
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener(APP_NAVIGATION, changed);
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  return location;
}

/** User navigation adds a destination; redirects replace only the current entry. */
export function navigateApp(href: string, { replace = false }: { replace?: boolean } = {}) {
  const destination = new URL(href, window.location.href);
  if (destination.origin !== window.location.origin) throw new Error("App navigation requires a local destination.");
  if (destination.href === window.location.href) return true;
  if (!window.dispatchEvent(new CustomEvent<URL>(BEFORE_APP_NAVIGATION, { detail: destination, cancelable: true }))) return false;
  const index = appHistoryIndex() ?? 0;
  if (appHistoryIndex() === null) window.history.replaceState(historyState(index), "", window.location.href);
  window.history[replace ? "replaceState" : "pushState"](replace ? historyState(index) : { gsvAppIndex: index + 1 }, "", destination.href);
  window.dispatchEvent(new Event(APP_NAVIGATION));
  return true;
}

export function AppLink({ href, class: className, target, children }: {
  href: string;
  class?: string;
  target?: string;
  children: ComponentChildren;
}) {
  const navigate = (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
      || (target && target !== "_self")) return;
    const destination = new URL(href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    event.preventDefault();
    navigateApp(destination.href);
  };
  return <a href={href} class={className} target={target} onClick={navigate}>{children}</a>;
}
