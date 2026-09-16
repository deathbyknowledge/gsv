import { useEffect, useRef } from "preact/hooks";

/**
 * Closes a transient popover when a pointer goes down anywhere outside it. `inside`
 * returns the elements that count as the popover and its trigger; a press on them, or
 * on anything within them, leaves it open. Keyboard dismissal stays with the caller.
 * The document listener exists only while `open` is true and goes away on close and
 * unmount.
 */
export function useDismissOnOutsideClick(open: boolean, inside: () => ReadonlyArray<Element | null | undefined>, dismiss: () => void): void {
  // Read at press time, so callers can pass inline functions without re-subscribing each render.
  const latest = useRef({ inside, dismiss });
  latest.current = { inside, dismiss };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const { inside, dismiss } = latest.current;
      // SAFETY: a pointer event targets the DOM node under the pointer.
      const target = event.target as Node | null;
      if (target && inside().some((element) => element?.contains(target))) return;
      dismiss();
    };
    // Capture, so a press still dismisses when something between here and the target stops the event.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
}
