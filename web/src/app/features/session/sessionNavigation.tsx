import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";

const SESSION_NAVIGATION = "gsv-session-navigation";

export function useSessionLocation() {
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, revision: 0 }));
  useLayoutEffect(() => {
    const changed = () => setLocation((current) => ({ pathname: window.location.pathname, revision: current.revision + 1 }));
    window.addEventListener(SESSION_NAVIGATION, changed);
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener(SESSION_NAVIGATION, changed);
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  return location;
}

export function SessionLink({ href, class: className, target, children }: {
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
    window.history.pushState(null, "", destination.href);
    window.dispatchEvent(new Event(SESSION_NAVIGATION));
  };
  return <a href={href} class={className} target={target} onClick={navigate}>{children}</a>;
}
