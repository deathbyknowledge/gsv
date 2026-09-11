import { useEffect, useLayoutEffect } from "preact/hooks";

/** Drafts stay local until saved; the owning surface guards navigation and reload. */
export function useDraftGuard(dirty: boolean, report?: (dirty: boolean) => void) {
  useLayoutEffect(() => { report?.(dirty); }, [dirty, report]);
  useLayoutEffect(() => () => report?.(false), [report]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
